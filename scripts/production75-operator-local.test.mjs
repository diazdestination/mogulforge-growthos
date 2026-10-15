import {test,expect} from 'vitest';
import {main} from './production75-operator-local.mjs';
import * as local from './production75-operator-local.mjs';
import {EventEmitter} from 'node:events';
test('idle client failure is handled without escaping cleanup',()=>{const c=new EventEmitter();let failures=0;expect(typeof local.handleOperatorClientErrors).toBe('function');local.handleOperatorClientErrors(c,()=>{failures++;});expect(()=>c.emit('error',new Error('synthetic idle failure'))).not.toThrow();expect(failures).toBe(1);});
test.each([[],['--execute'],['--run-local','--keep'],['--run-local','--target','production'],['--database-url','postgres://live']])('native entry refuses live/unscoped arguments %j',async args=>{await expect(main(args)).rejects.toMatchObject({safeCode:'production75_operator_local_action'});});
