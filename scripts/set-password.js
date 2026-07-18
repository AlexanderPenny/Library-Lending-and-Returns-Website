#!/usr/bin/env node

  //  Copyright 2026 Alexander L. Penny

  //  Licensed under the Apache License, Version 2.0 (the "License");
  //  you may not use this file except in compliance with the License.
  //  You may obtain a copy of the License at

  //      http://www.apache.org/licenses/LICENSE-2.0

  //  Unless required by applicable law or agreed to in writing, software
  //  distributed under the License is distributed on an "AS IS" BASIS,
  //  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  //  See the License for the specific language governing permissions and
  //  limitations under the License. 

/**
 * Interactively hash an admin password and print the line to add to .env.
 * Usage:  npm run set-password
 * The password is read without echoing to the screen.
 */
const bcrypt = require('bcryptjs');
const readline = require('readline');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const onData = (char) => {
        char = char + '';
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.removeListener('data', onData);
        } else {
          // overwrite the typed character
          process.stdout.write('\x1b[2K\x1b[200D' + question + '*'.repeat(rl.line.length));
        }
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const pw = await ask('New admin password: ', { hidden: true });
  if (!pw || pw.length < 8) {
    console.error('\nPassword must be at least 8 characters. Nothing written.');
    process.exit(1);
  }
  const pw2 = await ask('Confirm password: ', { hidden: true });
  if (pw !== pw2) {
    console.error('\nPasswords did not match. Nothing written.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(pw, 12);
  console.log('\nAdd (or update) this line in your .env file:\n');
  console.log('ADMIN_PASSWORD_HASH=' + hash + '\n');
})();
