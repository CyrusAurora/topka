import { test } from "node:test";
import assert from "node:assert/strict";
import { joinHalves, tidyCopy } from "@topka/contracts/card-text";
import { cleanField } from "@topka/backend/projects/issue-copy";

test("card copy: no space next to full-width punctuation, one space between plain halves", () => {
  assert.equal(joinHalves("ζ0 框架：", "人形机器人双维预判提成功"), "ζ0 框架：人形机器人双维预判提成功");
  assert.equal(joinHalves("ζ0 框架： ", " 人形机器人"), "ζ0 框架：人形机器人");
  assert.equal(joinHalves("联合预测视觉与关节轨迹，", "人形控制成功率最高提 18.8。"), "联合预测视觉与关节轨迹，人形控制成功率最高提 18.8。");
  assert.equal(joinHalves("Pollen 开源双足机器人", "成本降到 1 万"), "Pollen 开源双足机器人 成本降到 1 万");
  assert.equal(joinHalves("Robot", "（beta）"), "Robot（beta）");
  assert.equal(joinHalves("Only", ""), "Only");
  assert.equal(joinHalves("", "  b  "), "b");
  assert.equal(tidyCopy("轨迹，  人形 。 下一句 「引号 」"), "轨迹，人形。下一句「引号」");
  assert.equal(tidyCopy("GR00T  N1.7   项"), "GR00T N1.7 项");
  assert.equal(cleanField("「框架：  人形」"), "框架：人形");
});
