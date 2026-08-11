import { describe, expect, it } from 'vitest';
import { evaluateComposePolicy } from '../src/compose-policy.js';

const safe = `services:\n  web:\n    image: nginx:1.27.5\n    restart: unless-stopped\n`;

describe('deployment Compose policy', () => {
  it('normalizes deterministically and injects bounded resource defaults', () => {
    const first = evaluateComposePolicy(safe, 'reviewed_app');
    const second = evaluateComposePolicy(safe, 'reviewed_app');
    expect(first.checksum).toBe(second.checksum);
    expect(first.normalizedCompose).toContain('cpus: "1.0"');
    expect(first.normalizedCompose).toContain('memory: 512M');
    expect(first.warnings).toEqual(expect.arrayContaining([{ code: 'resource_defaults_injected', service: 'web' }, { code: 'healthcheck_recommended', service: 'web' }]));
  });

  it.each([
    ['build', `services:\n  web:\n    build: .\n    restart: always\n`],
    ['latest', `services:\n  web:\n    image: nginx:latest\n    restart: always\n`],
    ['privileged', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    privileged: true\n`],
    ['docker socket', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    volumes: [/var/run/docker.sock:/var/run/docker.sock]\n`],
    ['bind mount', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    volumes: [./data:/data]\n`],
    ['host network', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    network_mode: host\n`],
    ['published ports', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    ports: ["127.0.0.1:8080:80"]\n`],
    ['long-form published ports', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    ports:\n      - target: 80\n        published: "8080"\n        host_ip: 127.0.0.1\n`],
    ['exposed ports', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    expose: ["80"]\n`],
    ['command', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    command: [sh]\n`],
    ['literal secret', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    environment:\n      API_TOKEN: public-is-still-forbidden\n`],
    ['external volume', `services:\n  web:\n    image: nginx:1.2\n    restart: always\nvolumes:\n  data:\n    external: true\n`],
    ['include', `include: other.yaml\nservices:\n  web:\n    image: nginx:1.2\n    restart: always\n`],
    ['device reservation', `services:\n  web:\n    image: nginx:1.2\n    restart: always\n    deploy:\n      resources:\n        limits: {cpus: "1", memory: 512M}\n        reservations:\n          devices: [{capabilities: [gpu]}]\n`],
  ])('rejects forbidden %s configuration', (_name, compose) => {
    expect(() => evaluateComposePolicy(compose, 'reviewed_app')).toThrow();
  });

  it.each([
    ['ports', 'forbidden_ports'],
    ['expose', 'forbidden_expose'],
    ['network_mode', 'forbidden_network_mode'],
  ])('returns the exact phase-one exposure policy code for %s', (key, code) => {
    const compose = `${safe.trimEnd()}\n    ${key}: ${key === 'network_mode' ? 'host' : '["80"]'}\n`;
    expect(() => evaluateComposePolicy(compose, 'reviewed_app')).toThrow(expect.objectContaining({ code, service: 'web' }));
  });

  it('supports only bounded non-secret typed parameter overrides', () => {
    const result = evaluateComposePolicy(safe.replace('nginx:1.27.5', '${IMAGE}'), 'reviewed_app', { IMAGE: 'nginx:1.27.5' });
    expect(result.services[0]?.image).toBe('nginx:1.27.5');
    expect(() => evaluateComposePolicy(safe, 'reviewed_app', { API_TOKEN: 'secret' })).toThrow();
  });
});
