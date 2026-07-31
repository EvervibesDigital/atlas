import { describe, it, expect } from "vitest";
import { NICHE_CITY_COMBOS, pickNicheCity } from "../src/rotation";

describe("NICHE_CITY_COMBOS", () => {
  it("is the full cartesian product of 15 niches and 20 cities", () => {
    expect(NICHE_CITY_COMBOS.length).toBe(300);
  });

  it("has no duplicate niche+city pairs", () => {
    const seen = new Set(NICHE_CITY_COMBOS.map((c) => `${c.niche}|${c.city}`));
    expect(seen.size).toBe(NICHE_CITY_COMBOS.length);
  });
});

describe("pickNicheCity", () => {
  const combos = [
    { niche: "plumbers", city: "Columbus, OH" },
    { niche: "dentists", city: "Austin, TX" },
    { niche: "restaurants", city: "Denver, CO" },
  ];

  it("is a pure function of its seed — same seed always returns the same combo", () => {
    expect(pickNicheCity(5, combos)).toEqual(pickNicheCity(5, combos));
  });

  it("cycles through the list in order as the seed increments", () => {
    expect(pickNicheCity(0, combos)).toEqual(combos[0]);
    expect(pickNicheCity(1, combos)).toEqual(combos[1]);
    expect(pickNicheCity(2, combos)).toEqual(combos[2]);
  });

  it("wraps around to the start after the last combo", () => {
    expect(pickNicheCity(3, combos)).toEqual(combos[0]);
    expect(pickNicheCity(4, combos)).toEqual(combos[1]);
  });

  it("defaults to NICHE_CITY_COMBOS when no list is passed", () => {
    const picked = pickNicheCity(0);
    expect(picked).toEqual(NICHE_CITY_COMBOS[0]);
  });
});
