import { describe, expect, it } from "vitest";
import { type VaultItemData, newItemData, settleConflict } from "../src/vault";

const now = new Date("2031-03-01T09:00:00.000Z");

function item(password: string, notes = ""): VaultItemData {
  const it = newItemData("login");
  it.login!.password = password;
  it.notes = notes;
  return it;
}

describe("settleConflict", () => {
  it("adds the loser's changed secrets to the winner's Secret history, marked fromConflict", () => {
    const winner = { ...item("p1", "B notes"), modifiedAt: "2031-02-01T00:00:00.000Z" };
    const merged = settleConflict(winner, item("p2"), now)!;
    expect(merged.secretHistory).toEqual([
      { field: { kind: "password" }, value: "p2", changedAt: now.toISOString(), fromConflict: true },
    ]);
    expect(merged.notes).toBe("B notes");
    expect(merged.modifiedAt).toBe(winner.modifiedAt);
  });

  it("returns undefined when neither side lost a secret", () => {
    expect(settleConflict(item("p1", "a"), item("p1", "b"), now)).toBeUndefined();
  });

  it("does not repeat a value already in the winner's Secret history", () => {
    const winner = item("p2");
    winner.secretHistory = [{ field: { kind: "password" }, value: "p1", changedAt: now.toISOString() }];
    expect(settleConflict(winner, item("p1"), now)).toBeUndefined();
  });
});
