import type { SimtickInput, SimtickOutput } from '@sidekick/shared';
import { mulberry32, valueNoise2D } from './prng';

const GOODS: { name: string; base: number; demand: string[] }[] = [
  { name: 'bread', base: 2, demand: ['eat', 'trade'] },
  { name: 'ale', base: 3, demand: ['drink', 'socialize'] },
  { name: 'iron', base: 12, demand: ['smith', 'build'] },
  { name: 'herbs', base: 5, demand: ['gather', 'heal'] },
  { name: 'crystal', base: 40, demand: ['study', 'pray'] },
];
const WEATHER = ['clear', 'sunny', 'cloudy', 'windy', 'rain', 'fog', 'storm', 'snow'];
const ROLES = ['farmer', 'smith', 'merchant', 'guard', 'scholar', 'healer', 'builder', 'bard'];
const ROLE_WORK: Record<string, string> = {
  farmer: 'gather', smith: 'smith', merchant: 'trade', guard: 'patrol',
  scholar: 'study', healer: 'heal', builder: 'build', bard: 'socialize',
};
const MAX_SCHEDULES = 200;
const SUBSTEPS = 12;

export function simTick(input: SimtickInput): SimtickOutput {
  const { seed, tick, npcCount } = input;
  const areas = input.areaIds.length ? input.areaIds : ['town'];
  const rng = mulberry32((seed ^ Math.imul(tick + 1, 0x9e3779b1)) | 0);
  const hour = ((tick % 24) + 24) % 24;

  // Weather: smooth noise over time.
  const wn = valueNoise2D(seed, tick / 18, 0.5);
  const weather = WEATHER[Math.min(WEATHER.length - 1, Math.floor(wn * WEATHER.length))];
  const bad = weather === 'rain' || weather === 'storm' || weather === 'snow';

  const activityCounts: Record<string, number> = {};
  const schedules: SimtickOutput['schedules'] = [];
  for (let i = 0; i < npcCount; i++) {
    // Per-NPC needs simulated over sub-steps of this tick (deterministic from seed+tick+npc).
    const nr = mulberry32((seed * 31 + i * 2654435761 + tick * 97) | 0);
    const role = ROLES[i % ROLES.length];
    let hunger = valueNoise2D(seed + i, tick / 10, 1.5);
    let energy = valueNoise2D(seed + i, tick / 12, 2.5);
    let social = valueNoise2D(seed + i, tick / 14, 3.5);
    let activity = 'idle';
    for (let s = 0; s < SUBSTEPS; s++) {
      const h = (hour + s / SUBSTEPS) % 24;
      hunger = Math.min(1, hunger + 0.02 + nr() * 0.02);
      energy = Math.max(0, energy - 0.015 - (bad ? 0.01 : 0) + nr() * 0.005);
      social = Math.min(1, social + 0.01 + nr() * 0.01);
      if (h < 6 || h >= 22 || energy < 0.1) { activity = 'sleep'; energy = Math.min(1, energy + 0.08); }
      else if (hunger > 0.8) { activity = 'eat'; hunger -= 0.4; }
      else if (social > 0.85 && h >= 17) { activity = bad ? 'drink' : 'socialize'; social -= 0.5; }
      else if (role === 'healer' && nr() < 0.1) activity = 'pray';
      else activity = ROLE_WORK[role];
    }
    const area = areas[Math.floor(rng() * areas.length)];
    activityCounts[activity] = (activityCounts[activity] ?? 0) + 1;
    if (schedules.length < MAX_SCHEDULES) schedules.push({ npc: `npc-${i}`, areaId: area, activity });
  }

  const prices: Record<string, number> = {};
  const denom = Math.max(1, npcCount);
  for (let g = 0; g < GOODS.length; g++) {
    const good = GOODS[g];
    let demand = 0;
    for (const a of good.demand) demand += activityCounts[a] ?? 0;
    const cycle = 0.15 * Math.sin((tick / 24) * 2 * Math.PI + g);
    const noise = 0.2 * (valueNoise2D(seed + 500 + g, tick / 8, 0) - 0.5);
    const p = good.base * (1 + cycle + noise + 0.5 * (demand / denom) + (bad ? 0.05 : 0) + rng() * 0.02);
    prices[good.name] = Math.round(p * 100) / 100;
  }
  return { prices, schedules, weather };
}
