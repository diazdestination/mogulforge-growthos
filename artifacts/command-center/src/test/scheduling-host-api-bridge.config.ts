import base from '../../vitest.config.ts';
export default { ...base, test: { ...base.test, include: ['src/test/scheduling-host-api-bridge.proof.tsx'], maxWorkers: 1 } };
