// UI strings: common. `zh` is the Chinese copy as the product has it; `en` the same keys in English.
import type { Shape } from "./shape.ts";

const enMonthShort = (month: number): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, 1)));

export const zh = {
  today: "今天",
  yesterday: "昨天",
  todayLabel: "今天 · ",
  yesterdayLabel: "昨天 · ",
  monthDay: (month: number, day: number) => `${month}月${day}日`,
  monthDayYear: (year: number, month: number, day: number) => `${year}年${month}月${day}日`,
  justNow: "刚刚",
  minutesAgo: (n: number) => `${n} 分钟前`,
  hoursAgo: (n: number) => `${n} 小时前`,
  daysAgo: (n: number) => `${n} 天前`,
  fileTooLarge: "文件过大（上限 2,000,000 字符）",
  invalidJson: "不是有效的 JSON 文件",
  invalidFormat: "文件格式不对（需要 version: 1）",
  storageUnavailable: "浏览器存储已满或不可用，这次没有导入任何内容。",
};

export const en: Shape<typeof zh> = {
  today: "Today",
  yesterday: "Yesterday",
  todayLabel: "Today · ",
  yesterdayLabel: "Yesterday · ",
  monthDay: (month: number, day: number) => `${enMonthShort(month)} ${day}`,
  monthDayYear: (year: number, month: number, day: number) => `${enMonthShort(month)} ${day}, ${year}`,
  justNow: "Just now",
  minutesAgo: (n: number) => (n === 1 ? "1 minute ago" : `${n} minutes ago`),
  hoursAgo: (n: number) => (n === 1 ? "1 hour ago" : `${n} hours ago`),
  daysAgo: (n: number) => (n === 1 ? "1 day ago" : `${n} days ago`),
  fileTooLarge: "The file is too large (2,000,000 characters max)",
  invalidJson: "This is not a valid JSON file",
  invalidFormat: "Unrecognized file format (version: 1 required)",
  storageUnavailable: "Browser storage is full or unavailable; nothing was imported",
};
