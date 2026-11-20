// `pnpm check:config`: prints which integrations are configured and what stays stubbed.
import { cfg, formatIntegrationTable, integrationStatus } from './config';

const rows = integrationStatus();
console.log('\nSidekick config check (reads root .env)\n');
console.log(formatIntegrationTable(rows));
console.log(`\n${rows.filter((r) => r.configured).length}/${rows.length} integrations configured. USDC mint: ${cfg.USDC_MINT}\n`);
