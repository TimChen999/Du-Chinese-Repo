import { describe, it, expect, beforeEach } from "vitest";

import { detectSentence } from "../../src/content/sentence-detect";

function buildSingleNodeBlock(text: string): {
  node: Text;
  block: HTMLElement;
} {
  const block = document.createElement("p");
  const node = document.createTextNode(text);
  block.appendChild(node);
  document.body.appendChild(block);
  return { node, block };
}

function buildMultiNodeBlock(...parts: string[]): {
  nodes: Text[];
  block: HTMLElement;
} {
  const block = document.createElement("p");
  const nodes: Text[] = [];
  for (const part of parts) {
    if (part.startsWith("<b>")) {
      const b = document.createElement("b");
      const inner = document.createTextNode(part.slice(3, -4));
      b.appendChild(inner);
      block.appendChild(b);
      nodes.push(inner);
    } else {
      const t = document.createTextNode(part);
      block.appendChild(t);
      nodes.push(t);
    }
  }
  document.body.appendChild(block);
  return { nodes, block };
}

describe("detectSentence (single text node)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures a sentence around a caret in the middle", () => {
    const { node } = buildSingleNodeBlock("我爱中国。今天天气好。");
    const result = detectSentence(node, 3); // pointing inside "中"
    expect(result?.text).toBe("我爱中国。");
  });

  it("starts at the beginning when no left delimiter", () => {
    const { node } = buildSingleNodeBlock("我去银行取钱。");
    const result = detectSentence(node, 2);
    expect(result?.text).toBe("我去银行取钱。");
  });

  it("ends at end-of-block when no right delimiter", () => {
    const { node } = buildSingleNodeBlock("我去银行取钱");
    const result = detectSentence(node, 0);
    expect(result?.text).toBe("我去银行取钱");
  });

  it("treats . / ! / ? as delimiters too", () => {
    const { node } = buildSingleNodeBlock("Hello. 我去银行. Bye.");
    const result = detectSentence(node, 8); // inside 我
    expect(result?.text.includes("我去银行")).toBe(true);
    expect(result?.text.endsWith(".")).toBe(true);
  });

  it("respects multiple delimiters in a row", () => {
    const { node } = buildSingleNodeBlock("第一句。第二句！第三句？");
    const result = detectSentence(node, 5); // inside 第二句
    expect(result?.text).toBe("第二句！");
  });
});

describe("detectSentence (soft-limit clause fallback)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the full sentence when under the soft limit", () => {
    const { node } = buildSingleNodeBlock("我去银行取钱。");
    const result = detectSentence(node, 2);
    expect(result?.text).toBe("我去银行取钱。");
    expect(result?.trimmedToClause).toBeFalsy();
  });

  it("falls back to comma boundaries when sentence is too long", () => {
    // > 80 chars, with commas to split on. Click is in the middle clause.
    const longBody =
      "今天天气真的非常好" + "啊".repeat(40) + "，" +
      "我打算和我的朋友" + "去".repeat(20) + "公园玩一会儿，" +
      "然后再回家做晚饭。";
    const { node } = buildSingleNodeBlock(longBody);
    // Position the caret inside the middle clause (after the first comma).
    const firstCommaIdx = longBody.indexOf("，");
    const caret = firstCommaIdx + 5;
    const result = detectSentence(node, caret);
    expect(result?.trimmedToClause).toBe(true);
    // The trimmed result should be shorter than the full sentence.
    expect((result?.text.length ?? 0)).toBeLessThan(longBody.length);
    // The clause should not start at the original sentence start.
    expect(result?.text.startsWith("今天")).toBe(false);
  });

  it("keeps the full sentence when no commas exist to split on", () => {
    const longBody = "啊".repeat(120) + "。";
    const { node } = buildSingleNodeBlock(longBody);
    const result = detectSentence(node, 60);
    // No commas → clause walk produces same chunk → primary returned.
    expect(result?.trimmedToClause).toBeFalsy();
    expect(result?.text).toBe(longBody);
  });
});

describe("detectSentence (multiple text nodes)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("walks across an inline element boundary", () => {
    // <p>我去<b>银行</b>取钱。</p>
    const { nodes } = buildMultiNodeBlock("我去", "<b>银行</b>", "取钱。");
    // Click on 银 (first char of the bold node).
    const result = detectSentence(nodes[1], 0);
    expect(result?.text).toBe("我去银行取钱。");
  });

  it("returns a Range that covers the cross-node sentence", () => {
    const { nodes } = buildMultiNodeBlock("我去", "<b>银行</b>", "取钱。");
    const result = detectSentence(nodes[1], 0);
    expect(result?.range.toString()).toBe("我去银行取钱。");
  });

  it("does not cross a block boundary", () => {
    const p1 = document.createElement("p");
    const t1 = document.createTextNode("Earlier paragraph 这里。");
    p1.appendChild(t1);
    const p2 = document.createElement("p");
    const t2 = document.createTextNode("现在这一句。");
    p2.appendChild(t2);
    document.body.appendChild(p1);
    document.body.appendChild(p2);

    const result = detectSentence(t2, 2);
    expect(result?.text).toBe("现在这一句。");
  });
});
