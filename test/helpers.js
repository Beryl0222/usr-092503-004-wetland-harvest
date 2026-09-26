/** 测试用标准园区构造。 */
import { SchedulingEngine, FakeClock } from "../src/engine.js";

export const DAY = "2026-09-26";

export function buildPark(engineOpts = {}, parkOpts = {}) {
  const clock = engineOpts.clock ?? new FakeClock(`${DAY}T07:00:00.000Z`);
  const eng = new SchedulingEngine({ confirmGraceMs: 30 * 60 * 1000, ...engineOpts, clock });
  const crewN = parkOpts.crew ?? 3;
  const slotDefs = parkOpts.slots ?? [
    ["S1", "08:00", "10:00"],
    ["S2", "10:30", "12:30"],
    ["S3", "13:00", "15:00"],
    ["S4", "15:30", "17:30"]
  ];
  eng.seed({
    plots: [
      { id: "P1", name: "火柿湾", teamCap: parkOpts.plotCap ?? 2 },
      ...(parkOpts.plots ?? [])
    ],
    trees: [
      { id: "T1", plotId: "P1", ripeQty: parkOpts.ripe ?? 100 },
      { id: "T2", plotId: "P1", ripeQty: 60 }
    ],
    boats: [{ id: "B1", name: "采收一号", capacity: 12, maxWind: 8, minWater: 1.0 }],
    crew: Array.from({ length: crewN }, (_, i) => ({
      id: `C${i + 1}`, name: `船长${i + 1}`, boatIds: ["B1"]
    })),
    routes: [{ id: "R1", name: "西线", plotIds: ["P1"] }],
    slots: slotDefs.map(([id, s, e]) => ({
      id, routeId: "R1", boatId: "B1",
      startsAt: `${DAY}T${s}:00.000Z`, endsAt: `${DAY}T${e}:00.000Z`
    })),
    days: [{ operatingDay: DAY, totalCap: parkOpts.totalCap ?? 1000 }]
  });
  return { eng, clock };
}

export function iso(day, hhmm) {
  return `${day}T${hhmm}:00.000Z`;
}
