import { isIP } from 'node:net';

export const MAX_COMPOSE_SOURCE_BYTES = 1024 * 1024;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const COMMIT_PATTERN = /^[a-fA-F0-9]{40}$/;
const COMPOSE_PATH_PATTERN = /^[A-Za-z0-9._/-]+\.(?:ya?ml)$/i;

export interface GitComposeSource {
  repository: string;
  owner: string;
  repo: string;
  commitSha: string;
  composePath: string;
  rawUrl: string;
}

export class DeploymentSourceError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); }
}

export function normalizeGitComposeSource(repository: string, commitSha: string, composePath: string): GitComposeSource {
  const match = REPOSITORY_PATTERN.exec(repository);
  if (!match || repository.includes('@') || repository.endsWith('.git')) {
    throw new DeploymentSourceError('invalid_repository', 'repository must be a public https://github.com/{owner}/{repo} URL.');
  }
  if (!COMMIT_PATTERN.test(commitSha)) throw new DeploymentSourceError('invalid_commit', 'commitSha must contain exactly 40 hexadecimal characters.');
  const normalizedPath = composePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!COMPOSE_PATH_PATTERN.test(normalizedPath) || normalizedPath.startsWith('/') || normalizedPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new DeploymentSourceError('invalid_compose_path', 'composePath must be a normalized relative .yml or .yaml path without traversal.');
  }
  const owner = match[1]!;
  const repo = match[2]!;
  const revision = commitSha.toLowerCase();
  return {
    repository: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
    commitSha: revision,
    composePath: normalizedPath,
    rawUrl: `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${revision}/${normalizedPath.split('/').map(encodeURIComponent).join('/')}`,
  };
}

export async function fetchGitComposeSource(source: GitComposeSource, fetchImplementation: typeof globalThis.fetch): Promise<string> {
  const url = new URL(source.rawUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.username || url.password || isIP(url.hostname)) {
    throw new DeploymentSourceError('unsafe_source', 'The internally constructed Git source URL is unsafe.');
  }
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { accept: 'application/octet-stream', 'user-agent': 'GatewayControl/1' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DeploymentSourceError('source_unavailable', 'The public GitHub source could not be reached.');
  }
  if (response.status >= 300 && response.status < 400) throw new DeploymentSourceError('source_redirected', 'GitHub source redirects are not accepted.');
  if (!response.ok) throw new DeploymentSourceError('source_unavailable', `GitHub returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COMPOSE_SOURCE_BYTES) throw new DeploymentSourceError('source_too_large', 'Compose source exceeds 1 MiB.');
  if (!response.body) throw new DeploymentSourceError('source_unavailable', 'GitHub returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > MAX_COMPOSE_SOURCE_BYTES) {
      await reader.cancel();
      throw new DeploymentSourceError('source_too_large', 'Compose source exceeds 1 MiB.');
    }
    chunks.push(item.value);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new DeploymentSourceError('source_encoding', 'Compose source must be valid UTF-8.'); }
  if (!text.trim()) throw new DeploymentSourceError('source_empty', 'Compose source is empty.');
  return text;
}
