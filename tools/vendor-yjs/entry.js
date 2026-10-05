//What the Agora needs from the Yjs family, in one module: the CRDT, the sync and awareness protocols,
//and the encoding helpers the wire format uses.
export * as Y from 'yjs';
export * as syncProtocol from 'y-protocols/sync';
export * as awarenessProtocol from 'y-protocols/awareness';
export * as encoding from 'lib0/encoding';
export * as decoding from 'lib0/decoding';
