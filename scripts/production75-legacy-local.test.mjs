import {test,expect} from 'vitest';
import {main} from './production75-legacy-local.mjs';
test.each([[],['--database-url','postgres://live'],['--run-local','--keep'],['--restore'],['--run-local','--target','production']])('local oracle rejects unscoped/provider arguments %j before any resource operation',async args=>{await expect(main(args)).rejects.toMatchObject({safeCode:'production75_legacy_explicit_action'});});
