import { describe, expect, it } from "vitest";
import { folderKey, folders, inFolder, newItemData, resolveFolder } from "../src/vault";

const item = (folder: string, modifiedAt: string) => ({ ...newItemData("login"), folder, modifiedAt });

describe("Folders", () => {
  it("lists differently spelled versions as one Folder with the latest spelling", () => {
    const items = [
      item("Work", "2031-01-01T00:00:00.000Z"),
      item("work ", "2031-01-03T00:00:00.000Z"),
      item(" WORK", "2031-01-02T00:00:00.000Z"),
      item("Personal", "2031-01-01T00:00:00.000Z"),
      item("  ", "2031-01-04T00:00:00.000Z"),
      item("", "2031-01-04T00:00:00.000Z"),
    ];
    expect(folders(items)).toEqual(["Personal", "work"]);
  });

  it("matches Folder names ignoring case and surrounding spaces", () => {
    expect(folderKey("  Work ")).toBe("work");
    expect(inFolder(" work", "Work ")).toBe(true);
    expect(inFolder("Work", "Workshop")).toBe(false);
    expect(inFolder("", "")).toBe(false);
    expect(inFolder("  ", "")).toBe(false);
  });

  it("resolves a typed name to the existing Folder's spelling", () => {
    expect(resolveFolder(["Personal", "Work"], " work")).toBe("Work");
    expect(resolveFolder(["Personal", "Work"], " Travel ")).toBe("Travel");
  });
});
