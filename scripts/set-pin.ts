// Sets or changes the web-mode PIN (fork addition). Run on the server computer:
//   windows\set-pin.bat        (uses E:\HIT-data)
//   HIT_DATA_DIR=<folder> npm run pin
// Changing the PIN signs every device out. The running server picks it up without a restart.
import readline from 'readline';
import { validPin, writePin } from '../server/middleware/pin.js';

const dataDir = process.env.HIT_DATA_DIR?.trim();
if (!dataDir) {
    console.error('Set HIT_DATA_DIR to the data folder first (windows\\set-pin.bat does this).');
    process.exit(1);
}

function askHidden(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const out = rl as unknown as { _writeToOutput: (s: string) => void };
        let prompted = false;
        out._writeToOutput = (s: string) => {
            if (!prompted) {
                process.stdout.write(s);
                prompted = true;
            } else if (s.includes('\n') || s.includes('\r')) {
                process.stdout.write('\n');
            } else {
                process.stdout.write('*'.repeat(s.length));
            }
        };
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

const pin = await askHidden('New PIN (6-12 digits): ');
if (!validPin(pin)) {
    console.error('PIN must be 6 to 12 digits. Nothing changed.');
    process.exit(1);
}
const again = await askHidden('Same PIN again: ');
if (again !== pin) {
    console.error('The two PINs differ. Nothing changed.');
    process.exit(1);
}
writePin(dataDir, pin);
console.log(`PIN saved to ${dataDir}\\auth.json. Every device will need the new PIN.`);
