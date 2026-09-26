/**
 * 构造标准园区场景，供各测试复用。
 * 布局：
 *   地块 P_A（保育上限 100kg）：柿树 T_A1、T_A2
 *   地块 P_B（保育上限 60kg） ：柿树 T_B1
 *   船 B_BIG（载荷 100kg）/ B_SMALL（载荷 30kg）
 *   航线 R_NORTH 可达 T_A1,T_A2；航线 R_SOUTH 可达 T_B1
 *   航次 N_AM 09:00、N_PM 13:00（大船）；S_AM 09:30（小船）
 */
export function seedPark(eng, {
  date = "2026-09-26",
  treeCap = { T_A1: 60, T_A2: 60, T_B1: 40 },
  teamCapacity = { N_AM: 4, N_PM: 4, S_AM: 2 }
} = {}) {
  eng.upsertPlot({ id: "P_A", name: "北地块", dailyCapKg: 100 });
  eng.upsertPlot({ id: "P_B", name: "南地块", dailyCapKg: 60 });
  eng.upsertTree({ id: "T_A1", plotId: "P_A", name: "火柿A1" });
  eng.upsertTree({ id: "T_A2", plotId: "P_A", name: "火柿A2" });
  eng.upsertTree({ id: "T_B1", plotId: "P_B", name: "火柿B1" });
  for (const [treeId, kg] of Object.entries(treeCap)) eng.setTreeCapacity(treeId, date, kg);

  eng.upsertBoat({ id: "B_BIG", name: "采收船-大", payloadKg: 100 });
  eng.upsertBoat({ id: "B_SMALL", name: "采收船-小", payloadKg: 30 });

  eng.upsertCrew({ id: "C_SKIP", name: "船长", certs: ["water", "deck"] });
  eng.upsertCrew({ id: "C_DECK", name: "水手", certs: ["deck"] });

  eng.upsertRoute({ id: "R_NORTH", name: "北航线", treeIds: ["T_A1", "T_A2"] });
  eng.upsertRoute({ id: "R_SOUTH", name: "南航线", treeIds: ["T_B1"] });

  eng.createSailing({
    id: "N_AM", routeId: "R_NORTH", boatId: "B_BIG", capDate: date,
    departHhmm: "09:00", arriveHhmm: "11:00",
    teamCapacity: teamCapacity.N_AM, requiredCerts: ["water"], crewIds: ["C_SKIP"]
  });
  eng.createSailing({
    id: "N_PM", routeId: "R_NORTH", boatId: "B_BIG", capDate: date,
    departHhmm: "13:00", arriveHhmm: "15:00",
    teamCapacity: teamCapacity.N_PM, requiredCerts: ["water"], crewIds: ["C_SKIP"]
  });
  eng.createSailing({
    id: "S_AM", routeId: "R_SOUTH", boatId: "B_SMALL", capDate: date,
    departHhmm: "09:30", arriveHhmm: "10:30",
    teamCapacity: teamCapacity.S_AM, requiredCerts: ["water"], crewIds: ["C_SKIP"]
  });

  return { date };
}

export function seedTeams(eng, teams) {
  for (const [id, demandKg] of Object.entries(teams)) {
    eng.upsertTeam({ id, name: `团队-${id}`, demandKg });
  }
}
