// Sets or changes the web-mode PIN (fork addition). Run on the server computer:
//   windows\set-pin.bat        (uses E:\HIT-data)
//   HIT_DATA_DIR=<folder> npm run pin
// Changing the PIN signs every device out. The running server picks it up without a restart.
import readline from 'readline';
import { authPath, validPin, writePin } from '../server/middleware/pin.js';

const dataDir = process.env.HIT_DATA_DIR?.trim();
if (!dataDir) {
    console.error('Set HIT_DATA_DIR to the data folder first (windows\\set-pin.bat does this).');
    process.exit(1);
}

// One interface for both questions; typed characters show as '*'.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let hiding = false;
const out = rl as unknown as { _writeToOutput: (s: string) => void };
out._writeToOutput = (s: string) => {
    if (!hiding) process.stdout.write(s);
    else if (/[\r\n]/.test(s)) process.stdout.write('\n');
    else if (s.length === 1) process.stdout.write('*');
};
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string): Promise<string> {
    hiding = false;
    process.stdout.write(question);
    hiding = true;
    const { value, done } = await lines.next();
    hiding = false;
    if (!process.stdin.isTTY) process.stdout.write('\n');
    return done ? '' : String(value).trim();
}

function fail(message: string): never {
    console.error(`${message} Nothing changed.`);
    rl.close();
    process.exit(1);
}

const pin = await ask('New PIN (6-12 digits): ');
if (!validPin(pin)) fail('PIN must be 6 to 12 digits.');
const again = await ask('Same PIN again: ');
if (again !== pin) fail('The two PINs differ.');
rl.close();
writePin(dataDir, pin);
console.log(`PIN saved to ${authPath(dataDir)}. Every device will need the new PIN.`);
