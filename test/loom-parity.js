// Does tokenloom's Rust curve visit the cells in the same order as lib/hilbert.js?
//
//   node test/loom-parity.js [path-to-loom-cli]
//
// Every cell of orders 1..7, both directions. This is the check that makes the
// bridge a contract rather than two implementations that happen to look alike:
// the Rust writer lays bytes down in its order, tools/loom-himg.js reads them out
// in this one.

import { execFileSync } from 'node:child_process';
import { d2xy, xy2d } from '../lib/hilbert.js';

const cli = process.argv[2] || 'loom-cli';
const MAX_ORDER = 7;
let checked = 0;
let bad = 0;

for (let order = 1; order <= MAX_ORDER; order++) {
  const side = 1 << order;
  const cells = side * side;
  let table;
  try {
    table = JSON.parse(
      execFileSync(cli, ['hilbert', '--table', String(order)], { maxBuffer: 1 << 29 }),
    );
  } catch (e) {
    console.log(`order ${order}: cannot run ${cli} (${e.message.split('\n')[0]})`);
    bad++;
    continue;
  }
  if (table.order !== order || table.side !== side || table.points.length !== cells) {
    console.log(`order ${order}: table is ${table.points.length} points on side ${table.side}`);
    bad++;
    continue;
  }
  let orderBad = 0;
  for (let d = 0; d < cells; d++) {
    const [x, y] = d2xy(side, d);
    if (table.points[d][0] !== x || table.points[d][1] !== y) {
      console.log(`order ${order} d ${d}: js (${x},${y}) rust (${table.points[d].join(',')})`);
      orderBad++;
      break;
    }
    if (xy2d(side, x, y) !== d) {
      console.log(`order ${order}: reverse disagrees at (${x},${y})`);
      orderBad++;
      break;
    }
    checked++;
  }
  bad += orderBad;
  console.log(`order ${order}: ${cells} cells ${orderBad ? 'MISMATCH' : 'agree'}`);
}

console.log(`${checked} cells agree in both directions, ${bad} disagreements`);
process.exit(bad === 0 ? 0 : 1);
