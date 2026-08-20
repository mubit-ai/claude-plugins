// @ts-check
/**
 * The repository every A/B prompt is answered in.
 *
 * A sweep run in a real project is not reproducible: the repo changes under you between
 * versions, and `env_tags` derived from it change with it, so a delta measured in March and
 * one measured in August are about different codebases. This builds the same seven-line
 * project every time, from nothing, in the sweep's own raw directory.
 *
 * It is deliberately tiny. The kit measures what the plugin adds to a turn; a fixture large
 * enough to need real exploration buries that in the variance of the exploration.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CART = `def total(items):
    """Sum the prices in a cart. Prices are integer cents."""
    return sum(i["price"] for i in items) * 1.0


def count(items):
    return len(items)
`;

const TEST = `import cart


def test_total():
    assert cart.total([{"price": 2}, {"price": 3}]) == 5


def test_count():
    assert cart.count([{"price": 1}]) == 1
`;

const README = `# cart

A tiny shopping-cart helper. Prices are integer cents throughout.

Run the tests with \`python -m pytest\`.
`;

/**
 * @param {string} dir @returns {string} the fixture path
 */
export function buildFixture(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cart.py'), CART);
  writeFileSync(join(dir, 'test_cart.py'), TEST);
  writeFileSync(join(dir, 'README.md'), README);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=testkit@example.com', '-c', 'user.name=testkit', 'commit', '-qm', 'init');
  } catch { /* git is optional here; the run id falls back to a directory hash */ }
  return dir;
}
