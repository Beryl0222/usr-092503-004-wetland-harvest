/**
 * 可注入时钟。
 * - 生产使用系统时钟；
 * - 测试与日终审计可注入固定/可推进时钟，使"逾期释放、跨日结算"确定可重放。
 */
export function createClock(initial) {
  let current = initial === undefined ? null : new Date(initial);

  return {
    /** 当前时刻，Date 实例。 */
    now() {
      return current ? new Date(current) : new Date();
    },
    /** 当前时刻的 ISO 字符串。 */
    iso() {
      return this.now().toISOString();
    },
    /** 推进若干毫秒（仅注入时钟可用）。 */
    advance(ms) {
      if (!current) throw new Error("系统时钟不可推进");
      current = new Date(current.getTime() + ms);
      return this.iso();
    },
    /** 直接设定时刻。 */
    setNow(t) {
      current = new Date(t);
      return this.iso();
    },
    /** 当前日历日（YYYY-MM-DD，UTC，与 slot 日期口径一致）。 */
    today() {
      return this.iso().slice(0, 10);
    }
  };
}

/** 任意输入归一化为 ISO 字符串；非法输入抛错。 */
export function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError(`非法时间: ${value}`);
  return d.toISOString();
}

/** 把日期(YYYY-MM-DD)与时分(HH:MM)拼成 ISO（UTC）。 */
export function combineDateTime(date, hhmm, offsetMin = 0) {
  const iso = `${date}T${hhmmpad(hhmm)}:00.000Z`;
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + offsetMin);
  return d.toISOString();
}

function hhmmpad(hhmm) {
  const [h, m = "0"] = String(hhmm).split(":");
  return `${h.padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
