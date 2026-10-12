import {test,expect} from 'vitest';
import {main} from './production75-operator-local.mjs';
test.each([[],['--execute'],['--run-local','--keep'],['--run-local','--target','production'],['--database-url','postgres://live']])('native entry refuses live/unscoped arguments %j',async args=>{await expect(main(args)).rejects.toMatchObject({safeCode:'production75_operator_local_action'});});
