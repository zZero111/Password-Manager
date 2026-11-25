import { describe, expect, it } from "vitest";
import { TRASH_DAYS, isTrashed, newItemData, trashDaysLeft, trashExpired } from "../src/vault";

const DAY = 24 * 60 * 60 * 1000;
const trashedAt = "2031-03-01T09:00:00.000Z";
const at = (days: number) => new Date(Date.parse(trashedAt) + days * DAY);

describe("Trash", () => {
  const item = { ...newItemData("login"), trashedAt };

  it("knows which Items are in the Trash", () => {
    expect(isTrashed(item)).toBe(true);
    expect(isTrashed(newItemData("note"))).toBe(false);
  });

  it("counts days left before the Purge", () => {
    expect(trashDaysLeft(item, at(0))).toBe(TRASH_DAYS);
    expect(trashDaysLeft(item, at(0.5))).toBe(30);
    expect(trashDaysLeft(item, at(29))).toBe(1);
    expect(trashDaysLeft(item, at(31))).toBe(0);
  });

  it("expires after 30 days, not before", () => {
    expect(trashExpired(item, at(29))).toBe(false);
    expect(trashExpired(item, at(30))).toBe(false);
    expect(trashExpired(item, at(31))).toBe(true);
    expect(trashExpired(newItemData("login"), at(400))).toBe(false);
  });
});
