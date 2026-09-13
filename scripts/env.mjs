import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Loading an optional file here avoids watching a nonexistent --env-file path.
if (existsSync('.env.local')) loadEnvFile('.env.local');
