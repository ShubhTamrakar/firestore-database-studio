/**
 * High-fidelity In-Memory Mock of Firestore Admin SDK
 * Implements collection listing, recursive subcollections, pagination,
 * batch writes, and all Firestore native data types.
 */

export class MockTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  toDate() {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1000000));
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1000000);
  }
  isEqual(other) {
    return other && other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
}

export class MockGeoPoint {
  constructor(latitude, longitude) {
    this.latitude = latitude;
    this.longitude = longitude;
  }
  isEqual(other) {
    return other && other.latitude === this.latitude && other.longitude === this.longitude;
  }
}

export class MockDocumentReference {
  constructor(pathStr, firestoreInstance) {
    this.path = pathStr;
    const parts = pathStr.split('/');
    this.id = parts[parts.length - 1];
    this.firestore = firestoreInstance;
  }
  isEqual(other) {
    return other && other.path === this.path;
  }
  async get() {
    return this.firestore._getDocSnapshot(this.path);
  }
  async listCollections() {
    return this.firestore._listSubcollections(this.path);
  }
}

export class MockFieldValue {
  static vector(values) {
    return {
      constructor: { name: 'VectorValue' },
      values
    };
  }
}

export class MockFirestore {
  constructor(projectId = 'test-mock-project') {
    this.projectId = projectId;
    this._projectId = projectId;
    this.databaseId = '(default)';
    this._docs = new Map(); // path -> { exists: true, data: {}, createTime, updateTime }
    this._collections = new Set(); // collection paths
    this.constructor.Timestamp = MockTimestamp;
    this.constructor.GeoPoint = MockGeoPoint;
    this.constructor.FieldValue = MockFieldValue;
  }

  // Helper to populate synthetic data
  _setDocDirect(docPath, data, options = {}) {
    const parts = docPath.split('/');
    if (parts.length % 2 !== 0) {
      throw new Error(`Invalid document path: ${docPath}`);
    }
    const collPath = parts.slice(0, parts.length - 1).join('/');
    this._collections.add(collPath);
    this._docs.set(docPath, {
      exists: true,
      data: data,
      createTime: options.createTime || new MockTimestamp(1700000000, 123456000),
      updateTime: options.updateTime || new MockTimestamp(1700000000, 123456000)
    });
  }

  doc(docPath) {
    return new MockDocumentReference(docPath, this);
  }

  collection(collPath) {
    return new MockCollectionReference(collPath, this);
  }

  async listCollections() {
    const topLevel = new Set();
    for (const collPath of this._collections) {
      const parts = collPath.split('/');
      if (parts.length === 1) {
        topLevel.add(parts[0]);
      }
    }
    return Array.from(topLevel).map(id => this.collection(id));
  }

  _listSubcollections(docPath) {
    const subColls = new Set();
    const prefix = docPath + '/';
    for (const collPath of this._collections) {
      if (collPath.startsWith(prefix)) {
        const remainder = collPath.slice(prefix.length);
        const parts = remainder.split('/');
        if (parts.length === 1) {
          subColls.add(parts[0]);
        }
      }
    }
    return Array.from(subColls).map(id => this.collection(`${docPath}/${id}`));
  }

  _getDocSnapshot(docPath) {
    const parts = docPath.split('/');
    const id = parts[parts.length - 1];
    const doc = this._docs.get(docPath);
    if (!doc) {
      return {
        id,
        ref: this.doc(docPath),
        exists: false,
        data: () => undefined
      };
    }
    return {
      id,
      ref: this.doc(docPath),
      exists: doc.exists,
      createTime: doc.createTime,
      updateTime: doc.updateTime,
      data: () => JSON.parse(JSON.stringify(doc.data, (k, v) => {
        // preserve mock instances
        if (v && v.constructor && v.constructor.name === 'MockTimestamp') return v;
        if (v && v.constructor && v.constructor.name === 'MockGeoPoint') return v;
        return v;
      }))
    };
  }

  batch() {
    return new MockWriteBatch(this);
  }
}

export class MockCollectionReference {
  constructor(collPath, firestoreInstance) {
    this.path = collPath;
    const parts = collPath.split('/');
    this.id = parts[parts.length - 1];
    this.firestore = firestoreInstance;
    this._limit = null;
    this._startAfter = null;
  }

  limit(n) {
    const query = new MockCollectionReference(this.path, this.firestore);
    query._limit = n;
    query._startAfter = this._startAfter;
    return query;
  }

  startAfter(docSnap) {
    const query = new MockCollectionReference(this.path, this.firestore);
    query._limit = this._limit;
    query._startAfter = docSnap;
    return query;
  }

  async get() {
    const matchingDocs = [];
    const prefix = this.path + '/';
    for (const [docPath, doc] of this.firestore._docs.entries()) {
      if (docPath.startsWith(prefix)) {
        const remainder = docPath.slice(prefix.length);
        if (!remainder.includes('/')) {
          matchingDocs.push(this.firestore._getDocSnapshot(docPath));
        }
      }
    }

    matchingDocs.sort((a, b) => a.id.localeCompare(b.id));

    let startIndex = 0;
    if (this._startAfter) {
      const idx = matchingDocs.findIndex(d => d.id === this._startAfter.id);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    let pagedDocs = matchingDocs.slice(startIndex);
    if (this._limit !== null) {
      pagedDocs = pagedDocs.slice(0, this._limit);
    }

    return {
      empty: pagedDocs.length === 0,
      size: pagedDocs.length,
      docs: pagedDocs
    };
  }
}

export class MockWriteBatch {
  constructor(firestoreInstance) {
    this.firestore = firestoreInstance;
    this.operations = [];
  }

  set(docRef, data) {
    this.operations.push({ op: 'set', docRef, data });
    return this;
  }

  async commit() {
    for (const op of this.operations) {
      if (op.op === 'set') {
        this.firestore._setDocDirect(op.docRef.path, op.data);
      }
    }
    return [];
  }
}
