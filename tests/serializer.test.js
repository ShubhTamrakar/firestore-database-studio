import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeFirestoreValue,
  deserializeFirestoreValue,
  computeCanonicalDocumentHash,
  SerializationError
} from '../src/serializer.js';
import { MockTimestamp, MockGeoPoint, MockDocumentReference, MockFirestore } from './mock_firestore.js';

test('Serializer: handles primitive types, nulls, and special numbers', () => {
  const mockDb = new MockFirestore('test-proj');
  const input = {
    str: 'Hello 🌟 Firestore',
    boolTrue: true,
    boolFalse: false,
    nullVal: null,
    intVal: 42,
    floatVal: 3.1415926535,
    nanVal: NaN,
    infVal: Infinity,
    negInfVal: -Infinity
  };

  const serialized = serializeFirestoreValue(input);
  const deserialized = deserializeFirestoreValue(serialized, mockDb);

  assert.equal(deserialized.str, input.str);
  assert.equal(deserialized.boolTrue, true);
  assert.equal(deserialized.boolFalse, false);
  assert.equal(deserialized.nullVal, null);
  assert.equal(deserialized.intVal, 42);
  assert.equal(deserialized.floatVal, 3.1415926535);
  assert.ok(Number.isNaN(deserialized.nanVal));
  assert.equal(deserialized.infVal, Infinity);
  assert.equal(deserialized.negInfVal, -Infinity);
});

test('Serializer: preserves nanosecond timestamp precision', () => {
  const mockDb = new MockFirestore('test-proj');
  const originalTimestamp = new MockTimestamp(1729424847, 987654321);
  const doc = { createdAt: originalTimestamp };

  const serialized = serializeFirestoreValue(doc);
  assert.equal(serialized.createdAt.__fs_type__, 'Timestamp');
  assert.equal(serialized.createdAt.seconds, 1729424847);
  assert.equal(serialized.createdAt.nanoseconds, 987654321);

  const deserialized = deserializeFirestoreValue(serialized, mockDb, { TimestampClass: MockTimestamp });
  assert.equal(deserialized.createdAt.seconds, 1729424847);
  assert.equal(deserialized.createdAt.nanoseconds, 987654321);
  assert.ok(deserialized.createdAt.isEqual(originalTimestamp));
});

test('Serializer: preserves GeoPoint coordinates', () => {
  const mockDb = new MockFirestore('test-proj');
  const originalGeo = new MockGeoPoint(37.7749, -122.4194);
  const doc = { location: originalGeo };

  const serialized = serializeFirestoreValue(doc);
  assert.equal(serialized.location.__fs_type__, 'GeoPoint');
  assert.equal(serialized.location.latitude, 37.7749);
  assert.equal(serialized.location.longitude, -122.4194);

  const deserialized = deserializeFirestoreValue(serialized, mockDb, { GeoPointClass: MockGeoPoint });
  assert.equal(deserialized.location.latitude, 37.7749);
  assert.equal(deserialized.location.longitude, -122.4194);
  assert.ok(deserialized.location.isEqual(originalGeo));
});

test('Serializer: preserves Bytes / Buffer', () => {
  const mockDb = new MockFirestore('test-proj');
  const originalBuffer = Buffer.from('DISASTER_RECOVERY_TEST_PAYLOAD', 'utf8');
  const doc = { rawPayload: originalBuffer };

  const serialized = serializeFirestoreValue(doc);
  assert.equal(serialized.rawPayload.__fs_type__, 'Bytes');
  assert.equal(serialized.rawPayload.base64, originalBuffer.toString('base64'));

  const deserialized = deserializeFirestoreValue(serialized, mockDb);
  assert.ok(Buffer.isBuffer(deserialized.rawPayload));
  assert.ok(deserialized.rawPayload.equals(originalBuffer));
});

test('Serializer: preserves DocumentReferences and supports project remapping', () => {
  const sourceDb = new MockFirestore('project-alpha');
  const targetDb = new MockFirestore('project-beta');
  const ref = new MockDocumentReference('categories/electronics', sourceDb);
  const doc = { categoryRef: ref };

  const serialized = serializeFirestoreValue(doc);
  assert.equal(serialized.categoryRef.__fs_type__, 'DocumentReference');
  assert.equal(serialized.categoryRef.path, 'categories/electronics');
  assert.equal(serialized.categoryRef.projectId, 'project-alpha');

  // Deserialize without remapping: retains path
  const deserializedNoRemap = deserializeFirestoreValue(serialized, sourceDb);
  assert.equal(deserializedNoRemap.categoryRef.path, 'categories/electronics');

  // Deserialize with remapping to destination DB
  const deserializedRemap = deserializeFirestoreValue(serialized, targetDb, { remapProject: true });
  assert.equal(deserializedRemap.categoryRef.path, 'categories/electronics');
  assert.equal(deserializedRemap.categoryRef.firestore.projectId, 'project-beta');
});

test('Serializer: rejects unsupported arbitrary classes to avoid silent coercion', () => {
  class CustomUnregisteredObject {
    constructor() { this.hidden = 123; }
  }
  const doc = { payload: new CustomUnregisteredObject() };

  assert.throws(
    () => serializeFirestoreValue(doc),
    SerializationError
  );
});

test('Serializer: rejects undefined value', () => {
  const doc = { invalid: undefined };
  assert.throws(
    () => serializeFirestoreValue(doc),
    SerializationError
  );
});

test('Canonical Hasher: is key-order invariant and deterministic', () => {
  const docA = { a: 1, b: 2, c: { x: 10, y: 20 } };
  const docB = { c: { y: 20, x: 10 }, b: 2, a: 1 };

  const serializedA = serializeFirestoreValue(docA);
  const serializedB = serializeFirestoreValue(docB);

  const hashA = computeCanonicalDocumentHash('users/u1', serializedA);
  const hashB = computeCanonicalDocumentHash('users/u1', serializedB);

  assert.equal(hashA, hashB, 'Hashes must be identical regardless of original property insertion order');
});
