import test from "node:test";
import assert from "node:assert/strict";
import { CSV_COLUMNS, exportToCsv } from "../proposalExportFormat.js";

function document(body) {
  return { schemaVersion: 2, exportedAt: "2026-11-04T00:00:00.000Z", postings: [{
    id: "posting", title: "Posting", summary: "Summary", proposals: [{
      id: "proposal", title: "Proposal", comments: [{ id: "comment", body }],
    }],
  }] };
}

// Read serialized CSV, including quoted embedded newlines and doubled quotes.
function rows(csv) {
  const result = []; let row = [], cell = "", quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === ",") { row.push(cell); cell = ""; }
    else if (!quoted && char === "\r" && csv[index + 1] === "\n") {
      row.push(cell); result.push(row); row = []; cell = ""; index++;
    } else cell += char;
  }
  assert.equal(quoted, false);
  return result;
}

test("CSV blocks formula introducers hidden behind ignored prefixes without changing JSON", () => {
  for (const prefix of ["", "\u0000", "\u0000\u0000", " \u0000\t", "  ", "\r\n", "\u200b", "\ufeff\u0000"]) {
    for (const operator of ["=", "+", "-", "@", "\uff1d", "\uff0b", "\uff0d", "\uff20"]) {
      const body = `${prefix}${operator}1+1`, original = document(body);
      const before = JSON.stringify(original);
      const parsed = rows(exportToCsv(original));
      assert.deepEqual(parsed[0], CSV_COLUMNS);
      assert.equal(parsed[1][CSV_COLUMNS.indexOf("commentBody")], `'${body}`);
      assert.equal(JSON.stringify(original), before);
      assert.equal(JSON.parse(before).postings[0].proposals[0].comments[0].body, body);
    }
  }
});

test("CSV keeps ordinary text and correctly quotes protected multiline cells", () => {
  for (const body of ["ordinary = note", " \u0000ordinary text", "1+1", "'=1+1", "ordinary, \"quoted\"\r\ntext"]) {
    const parsed = rows(exportToCsv(document(body)));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].length, CSV_COLUMNS.length);
    assert.equal(parsed[1][CSV_COLUMNS.indexOf("commentBody")], body);
  }
  const body = '\u0000=1+1,"quoted"\r\nnext line';
  const parsed = rows(exportToCsv(document(body)));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("commentBody")], `'${body}`);
});

test("the shared guard covers posting and proposal metadata as well as comments", () => {
  const original = document("Safe comment");
  original.postings[0].title = "\u0000=1+1";
  original.postings[0].proposals[0].summary = "  +1+1";
  const parsed = rows(exportToCsv(original));
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("postingTitle")], "'\u0000=1+1");
  assert.equal(parsed[1][CSV_COLUMNS.indexOf("proposalSummary")], "'  +1+1");
});
