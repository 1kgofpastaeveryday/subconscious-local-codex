/**
 * One-time OAuth login script.
 * Run: npx tsx oauth-login.ts
 * Opens browser, completes OAuth, saves tokens to data/openai-tokens.json.
 */
import { getAccessToken } from './openai-oauth.js';

async function main() {
  try {
    console.log('Starting OpenAI OAuth login...');
    const token = await getAccessToken();
    console.log(`\nSuccess! Token obtained (${token.length} chars)`);
    console.log('Tokens saved to data/openai-tokens.json');
    console.log('\nYou can now start the server: npx tsx server.ts');
    process.exit(0);
  } catch (err: any) {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  }
}

main();
