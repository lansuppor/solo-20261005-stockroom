import { main } from './src/cli.ts';

process.exitCode = main(process.argv.slice(2));
