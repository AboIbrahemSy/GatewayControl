import { describe, expect, it, vi } from 'vitest';
import { fetchGitComposeSource, MAX_COMPOSE_SOURCE_BYTES, normalizeGitComposeSource } from '../src/deployment-source.js';

describe('Git deployment source', () => {
  it('constructs the only allowed raw GitHub URL from strict source components', () => {
    const source = normalizeGitComposeSource('https://github.com/example/reviewed-app', 'A'.repeat(40), 'deploy/compose.yaml');
    expect(source.rawUrl).toBe(`https://raw.githubusercontent.com/example/reviewed-app/${'a'.repeat(40)}/deploy/compose.yaml`);
    for (const repository of ['http://github.com/a/b', 'https://github.com/a/b.git', 'https://user@github.com/a/b', 'https://github.example/a/b', 'https://127.0.0.1/a/b']) {
      expect(() => normalizeGitComposeSource(repository, 'a'.repeat(40), 'compose.yaml')).toThrow();
    }
  });

  it('rejects traversal, absolute paths, unsupported extensions, and non-fixed commits', () => {
    for (const path of ['../compose.yaml', '/compose.yaml', 'deploy//compose.yaml', 'compose.json', 'C:\\compose.yaml']) {
      expect(() => normalizeGitComposeSource('https://github.com/example/app', 'a'.repeat(40), path)).toThrow();
    }
    expect(() => normalizeGitComposeSource('https://github.com/example/app', 'main', 'compose.yaml')).toThrow();
  });

  it('disables redirects and counts the response body independently of content type', async () => {
    const source = normalizeGitComposeSource('https://github.com/example/app', 'a'.repeat(40), 'compose.yaml');
    const redirectFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://internal.test/' } }));
    await expect(fetchGitComposeSource(source, redirectFetch)).rejects.toMatchObject({ code: 'source_redirected' });
    expect(redirectFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });

    const largeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(MAX_COMPOSE_SOURCE_BYTES + 1), { headers: { 'content-type': 'text/plain' } }));
    await expect(fetchGitComposeSource(source, largeFetch)).rejects.toMatchObject({ code: 'source_too_large' });
  });
});
