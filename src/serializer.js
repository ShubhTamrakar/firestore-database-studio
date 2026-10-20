import crypto from 'crypto';

/**
 * Type-Preserving Serializer and Canonical Hasher for Firestore Data.
 * Fully reversible, prevents silent coercion, handles nanosecond timestamps,
 * GeoPoints, DocumentReferences, Buffers, Vectors, and special numbers.
 */

export class SerializationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SerializationError';
    this.details = details;
  }
}

export function serializeFirestoreValue(value, options = {}) {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    throw new SerializationError('Cannot serialize undefined value; Firestore does not support undefined values.');
  }

  const type = typeof value;

  if (type === 'boolean' || type === 'string') {
    return value;
  }

  if (type === 'number') {
    if (Number.isNaN(value)) {
      return { __fs_type__: 'SpecialNumber', value: 'NaN' };
    }
    if (value === Infinity) {
      return { __fs_type__: 'SpecialNumber', value: 'Infinity' };
    }
    if (value === -Infinity) {
      return { __fs_type__: 'SpecialNumber', value: '-Infinity' };
    }
    // Record numeric type explicitly if integer vs float matters
    return value;
  }

  if (type === 'bigint') {
    return { __fs_type__: 'BigInt', value: value.toString() };
  }

  // Handle Buffer / Uint8Array / Bytes
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      __fs_type__: 'Bytes',
      base64: Buffer.from(value).toString('base64')
    };
  }

  // Handle Firestore Timestamp (checks for seconds and nanoseconds properties)
  if (value && typeof value.toDate === 'function' && typeof value.seconds === 'number' && typeof value.nanoseconds === 'number') {
    return {
      __fs_type__: 'Timestamp',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds
    };
  }

  // Handle Firestore GeoPoint (checks latitude and longitude properties)
  if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number' && value.isEqual) {
    return {
      __fs_type__: 'GeoPoint',
      latitude: value.latitude,
      longitude: value.longitude
    };
  }

  // Handle Firestore DocumentReference (checks id, path, and firestore properties)
  if (value && typeof value.path === 'string' && value.firestore && typeof value.isEqual === 'function') {
    const projectId = value.firestore.projectId || (value.firestore._projectId) || null;
    const databaseId = value.firestore.databaseId || '(default)';
    return {
      __fs_type__: 'DocumentReference',
      projectId,
      databaseId,
      path: value.path
    };
  }

  // Handle Firestore VectorValue if present
  if (value && Array.isArray(value.values) && value.constructor && value.constructor.name === 'VectorValue') {
    return {
      __fs_type__: 'VectorValue',
      values: value.values
    };
  }

  // Handle Array
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      try {
        return serializeFirestoreValue(item, options);
      } catch (err) {
        throw new SerializationError(`Failed to serialize array element at index ${index}: ${err.message}`, { index, cause: err });
      }
    });
  }

  // Handle Plain Object / Map
  if (type === 'object') {
    // If it has a prototype other than Object or null, reject to avoid silent data loss
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      // Check if it's a known Firestore internal type not matched above
      if (value.constructor && value.constructor.name) {
        throw new SerializationError(`Unsupported custom object instance '${value.constructor.name}'. Silent coercion rejected.`);
      }
    }

    const serializedObj = {};
    // Sort keys deterministically
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      serializedObj[key] = serializeFirestoreValue(value[key], options);
    }
    return serializedObj;
  }

  throw new SerializationError(`Unsupported data type '${type}' for value: ${String(value)}`);
}

export function deserializeFirestoreValue(value, firestoreInstance = null, options = {}) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserializeFirestoreValue(item, firestoreInstance, options));
  }

  // Check for our custom type tag
  if (value.__fs_type__) {
    switch (value.__fs_type__) {
      case 'SpecialNumber':
        if (value.value === 'NaN') return NaN;
        if (value.value === 'Infinity') return Infinity;
        if (value.value === '-Infinity') return -Infinity;
        throw new SerializationError(`Unknown SpecialNumber value '${value.value}'`);

      case 'BigInt':
        return BigInt(value.value);

      case 'Bytes':
        return Buffer.from(value.base64, 'base64');

      case 'Timestamp': {
        if (!firestoreInstance || !firestoreInstance.constructor || !firestoreInstance.constructor.Timestamp) {
          // Fallback if Timestamp class not bound on instance
          const { Timestamp } = options.TimestampClass ? options : { Timestamp: null };
          if (Timestamp) {
            return new Timestamp(value.seconds, value.nanoseconds);
          }
        }
        // Admin SDK Firestore Timestamp
        const TimestampClass = options.TimestampClass || (firestoreInstance ? firestoreInstance.constructor.Timestamp : null);
        if (TimestampClass) {
          return new TimestampClass(value.seconds, value.nanoseconds);
        }
        // Generic representation with toDate() and isEqual()
        return {
          seconds: value.seconds,
          nanoseconds: value.nanoseconds,
          toDate: () => new Date(value.seconds * 1000 + Math.floor(value.nanoseconds / 1000000)),
          toMillis: () => value.seconds * 1000 + Math.floor(value.nanoseconds / 1000000)
        };
      }

      case 'GeoPoint': {
        const GeoPointClass = options.GeoPointClass || (firestoreInstance ? firestoreInstance.constructor.GeoPoint : null);
        if (GeoPointClass) {
          return new GeoPointClass(value.latitude, value.longitude);
        }
        return {
          latitude: value.latitude,
          longitude: value.longitude,
          isEqual: (other) => other && other.latitude === value.latitude && other.longitude === value.longitude
        };
      }

      case 'DocumentReference': {
        let docPath = value.path;
        if (options.remapProject && firestoreInstance) {
          // If restoring to a new project and remapping is enabled
          return firestoreInstance.doc(docPath);
        }
        if (firestoreInstance && typeof firestoreInstance.doc === 'function') {
          return firestoreInstance.doc(docPath);
        }
        return {
          path: docPath,
          projectId: value.projectId,
          databaseId: value.databaseId,
          isDocumentReference: true
        };
      }

      case 'VectorValue': {
        const FieldValueClass = options.FieldValueClass || (firestoreInstance ? firestoreInstance.constructor.FieldValue : null);
        if (FieldValueClass && typeof FieldValueClass.vector === 'function') {
          return FieldValueClass.vector(value.values);
        }
        return { values: value.values };
      }

      default:
        throw new SerializationError(`Unrecognized serialized Firestore type '${value.__fs_type__}'`);
    }
  }

  // Regular plain object / map
  const deserialized = {};
  for (const key of Object.keys(value)) {
    deserialized[key] = deserializeFirestoreValue(value[key], firestoreInstance, options);
  }
  return deserialized;
}

/**
 * Computes deterministic canonical SHA-256 hash for document payload
 */
export function computeCanonicalDocumentHash(docPath, serializedData) {
  // Sort keys deterministically
  const canonicalString = JSON.stringify({
    path: docPath,
    data: serializedData
  }, Object.keys({ path: null, data: null }).sort());

  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}
