import sharp from "sharp";
import { parseFocus, detectFocus } from "../../../methods/files/focusPoint.js";

// A grey image with one bright red disc: the "subject".
async function imageWithSubject(w, h, cx, cy) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#777"/>
    <circle cx="${cx}" cy="${cy}" r="40" fill="#f20"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

describe("parseFocus", () => {
  test("accepts objects and form strings, clamps to 0..1", () => {
    expect(parseFocus({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });
    expect(parseFocus("0.3,1.4")).toEqual({ x: 0.3, y: 1 });
    expect(parseFocus("-1,0.5")).toEqual({ x: 0, y: 0.5 });
  });

  test("rejects junk", () => {
    expect(parseFocus(undefined)).toBeNull();
    expect(parseFocus("x")).toBeNull();
    expect(parseFocus("1,2,3")).toBeNull();
    expect(parseFocus({ x: "a", y: 1 })).toBeNull();
  });
});

describe("detectFocus", () => {
  test("finds the subject in a landscape image", async () => {
    const focus = await detectFocus(await imageWithSubject(800, 400, 650, 100));
    expect(focus.x).toBeGreaterThan(0.7);
    expect(focus.y).toBeLessThan(0.35);
  });

  test("finds the subject in a tall portrait", async () => {
    const focus = await detectFocus(await imageWithSubject(400, 1000, 100, 850));
    expect(focus.x).toBeLessThan(0.35);
    expect(focus.y).toBeGreaterThan(0.75);
  });

  test("returns null for something that isn't an image", async () => {
    expect(await detectFocus(Buffer.from("not an image"))).toBeNull();
  });
});
