import { query } from '../pool.ts';
import { parseTriggerConfig } from '../../lib/scanner/config-schema.ts';
import type { Strategy } from '../../lib/scanner/types.ts';

interface StrategyRow {
  id: string; enabled: boolean; symbols: string[];
  trigger_config: unknown; risk_params: Record<string, unknown>; version: number; skill_name: string | null;
}

function toStrategy(r: StrategyRow): Strategy {
  return {
    id: r.id, enabled: r.enabled, symbols: r.symbols,
    triggerConfig: parseTriggerConfig(r.trigger_config), riskParams: r.risk_params,
    version: r.version, skillName: r.skill_name,
  };
}

const SELECT = 'SELECT id, enabled, symbols, trigger_config, risk_params, version, skill_name FROM kairos.strategies';

export async function getStrategy(id: string): Promise<Strategy | null> {
  const rows = await query<StrategyRow>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? toStrategy(rows[0]) : null;
}

export async function getEnabledStrategies(): Promise<Strategy[]> {
  const rows = await query<StrategyRow>(`${SELECT} WHERE enabled = true`, []);
  return rows.map(toStrategy);
}
