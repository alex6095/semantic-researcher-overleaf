import * as assert from 'assert';
import * as http2 from 'http2';
import { BaseAPI, Identity } from '../../api/base';

function documentIdFromPath(requestPath: string): string {
    const match = /^\/project\/[^/]+\/doc\/([^/]+)\/download$/.exec(requestPath);
    assert.ok(match, `Unexpected document snapshot path: ${requestPath}`);
    return decodeURIComponent(match[1]);
}

async function listen(server: http2.Http2Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address!=='string');
    return address.port;
}

async function close(server: http2.Http2Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) { clearTimeout(timer); }
    }
}

suite('HTTP/2 document snapshot bootstrap', () => {
    const identity: Identity = {csrfToken: 'test-csrf', cookies: 'session=test'};

    test('bounds real HTTP/2 bootstrap streams while retaining request order', async function () {
        this.timeout(10000);
        const server = http2.createServer();
        let activeStreams = 0;
        let maxActiveStreams = 0;
        const requestedCookies: string[] = [];
        server.on('stream', (stream, headers) => {
            const docId = documentIdFromPath(String(headers[':path'] ?? ''));
            requestedCookies.push(String(headers.cookie ?? ''));
            activeStreams += 1;
            maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
            stream.respond({
                [http2.constants.HTTP2_HEADER_STATUS]: 200,
                [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'text/plain',
            });
            setTimeout(() => {
                stream.end(`h2:${docId}`);
                activeStreams -= 1;
            }, 15);
        });
        const port = await listen(server);
        const api = new BaseAPI(`http://127.0.0.1:${port}/`);
        const documentIds = Array.from({length: 25}, (_, index) => `doc-${index}`);

        try {
            const snapshots = await api.getDocumentSnapshots(identity, 'project-1', documentIds);
            assert.strictEqual(api.documentSnapshotTransport, 'h2');
            assert.deepStrictEqual([...snapshots.keys()], documentIds);
            assert.strictEqual(
                new TextDecoder().decode(snapshots.get('doc-24')),
                'h2:doc-24',
            );
            assert.ok(maxActiveStreams>1, 'the bootstrap should use parallel h2 streams');
            assert.ok(maxActiveStreams<=8, `expected at most 8 streams, saw ${maxActiveStreams}`);
            assert.deepStrictEqual(requestedCookies, documentIds.map(() => 'session=test'));
        } finally {
            await close(server);
        }
    });

    test('uses authenticated HTTP/1 fallback after a real HTTP/2 GOAWAY', async function () {
        this.timeout(10000);
        const server = http2.createServer();
        const sessions = new Set<http2.ServerHttp2Session>();
        server.on('session', session => {
            sessions.add(session);
            session.once('close', () => sessions.delete(session));
        });
        let h2Requests = 0;
        server.on('stream', stream => {
            h2Requests += 1;
            stream.on('error', () => undefined);
            // lastStreamId=0 says no client stream is guaranteed processed.
            stream.session.goaway(http2.constants.NGHTTP2_NO_ERROR, 0);
            stream.close(http2.constants.NGHTTP2_CANCEL);
        });
        const port = await listen(server);
        const api = new BaseAPI(`http://127.0.0.1:${port}/`);
        const fallbackDocumentIds: string[] = [];
        (api as any).getDocumentSnapshot = async (
            _identity: Identity,
            _projectId: string,
            docId: string,
        ) => {
            fallbackDocumentIds.push(docId);
            return {type: 'success', content: new TextEncoder().encode(`http1:${docId}`)};
        };

        try {
            const snapshots = await within(
                api.getDocumentSnapshots(identity, 'project-1', ['doc-a', 'doc-b']),
                2_000,
                'GOAWAY fallback',
            );
            assert.ok(h2Requests>=1, 'the h2 server should receive the bootstrap attempt');
            assert.deepStrictEqual(fallbackDocumentIds, ['doc-a', 'doc-b']);
            assert.strictEqual(api.documentSnapshotTransport, 'http1');
            assert.strictEqual(new TextDecoder().decode(snapshots.get('doc-b')), 'http1:doc-b');
        } finally {
            for (const session of sessions) { session.destroy(); }
            await close(server);
        }
    });

    test('falls back promptly when a real HTTP/2 document stream is reset', async function () {
        this.timeout(10000);
        const server = http2.createServer();
        server.on('stream', stream => {
            stream.on('error', () => undefined);
            // Refuse the stream before any response body. This is a real RST,
            // not a synthetic rejected promise, and mirrors a peer enforcing a
            // lower concurrent-stream budget while bootstrap is in flight.
            stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
        });
        const port = await listen(server);
        const api = new BaseAPI(`http://127.0.0.1:${port}/`);
        const fallbackDocumentIds: string[] = [];
        (api as any).getDocumentSnapshot = async (
            _identity: Identity,
            _projectId: string,
            docId: string,
        ) => {
            fallbackDocumentIds.push(docId);
            return {type: 'success', content: new TextEncoder().encode(`http1:${docId}`)};
        };

        try {
            const snapshots = await api.getDocumentSnapshots(identity, 'project-1', ['doc-a']);
            assert.deepStrictEqual(fallbackDocumentIds, ['doc-a']);
            assert.strictEqual(api.documentSnapshotTransport, 'http1');
            assert.strictEqual(new TextDecoder().decode(snapshots.get('doc-a')), 'http1:doc-a');
        } finally {
            await close(server);
        }
    });
});
