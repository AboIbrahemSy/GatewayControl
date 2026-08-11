import { describe, expect, it } from 'vitest';
import { boundedInteger, parseProtectedProjects, validateRestoreStageRoot } from '../src/config.js';

describe('restore path configuration', () => {
  it('requires the stage root to resolve strictly inside the shared local backup root', () => {
    expect(validateRestoreStageRoot('/srv/gateway/backups', '/srv/gateway/backups/.restore-stage'))
      .toBe('/srv/gateway/backups/.restore-stage');
    expect(() => validateRestoreStageRoot('/srv/gateway/backups', '/srv/gateway/backups')).toThrow('must not equal');
    expect(() => validateRestoreStageRoot('/srv/gateway/backups', '/srv/gateway/backups/../outside')).toThrow('must resolve inside');
    expect(() => validateRestoreStageRoot('relative', '/srv/gateway/backups/.restore-stage')).toThrow('absolute paths');
  });
});

describe('protected project configuration', () => {
  it('always includes the canonical project and validates bounded unique additions', () => {
    expect(parseProtectedProjects('edge, gateway-control,api_one')).toEqual(['gateway-control', 'edge', 'api_one']);
    expect(() => parseProtectedProjects('Invalid.Project')).toThrow('valid comma-separated');
    expect(() => parseProtectedProjects(Array.from({ length: 21 }, (_, index) => `p${index}`).join(','))).toThrow('at most 20');
  });
});

describe('notification topology limits', () => {
  it('accepts bounded integers and rejects unsafe values', () => {
    expect(boundedInteger(undefined, 'LIMIT', 100, 1_000)).toBe(100);
    expect(boundedInteger('250', 'LIMIT', 100, 1_000)).toBe(250);
    expect(() => boundedInteger('0', 'LIMIT', 100, 1_000)).toThrow('between 1 and 1000');
    expect(() => boundedInteger('1001', 'LIMIT', 100, 1_000)).toThrow('between 1 and 1000');
  });
});
