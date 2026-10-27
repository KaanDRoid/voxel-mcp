import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appAnimationCommands} from '../src/appControl.js';

test('native animation commands use explicit bounded native speed, range and frame fields, never pretend FPS',()=>{
 assert.deepEqual(appAnimationCommands({start:2,end:7,frameIndex:3,speed:25}),['set a_min 0','set a_max 7','set a_min 2','set a_time 3','set a_speed 25']);
 assert.deepEqual(appAnimationCommands({speed:0}),['set a_speed 0']);
 for(const value of [{},{start:0},{end:3},{start:4,end:3},{start:0,end:361},{frameIndex:-1},{speed:101},{speed:NaN},{speed:1,fps:10}])assert.throws(()=>appAnimationCommands(value));
});
