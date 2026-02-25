// ============================================================================
// Tests — Expense Parser
// Run: npm test
// ============================================================================

import { describe, it, expect } from "vitest";
import { parseExpenseRegex } from "../src/services/expense-parser.js";

describe("parseExpenseRegex", () => {
  it('parses "gasté 5000 en pizza"', () => {
    const result = parseExpenseRegex("gasté 5000 en pizza");
    expect(result).toEqual({
      amount: 5000,
      description: "pizza",
      category: "comida",
    });
  });

  it('parses "pagué $1.500 de luz"', () => {
    const result = parseExpenseRegex("pagué $1.500 de luz");
    expect(result).toEqual({
      amount: 1500,
      description: "luz",
      category: "servicios",
    });
  });

  it('parses "uber $3200"', () => {
    const result = parseExpenseRegex("uber $3200");
    expect(result).toEqual({
      amount: 3200,
      description: "uber",
      category: "transporte",
    });
  });

  it('parses "5000 pizza"', () => {
    const result = parseExpenseRegex("5000 pizza");
    expect(result).toEqual({
      amount: 5000,
      description: "pizza",
      category: "comida",
    });
  });

  it('parses "$2.500,50 en supermercado"', () => {
    const result = parseExpenseRegex("$2.500,50 en supermercado");
    expect(result).toEqual({
      amount: 2500.5,
      description: "supermercado",
      category: "supermercado",
    });
  });

  it('parses "compré 800 en café"', () => {
    const result = parseExpenseRegex("compré 800 en café");
    expect(result).toEqual({
      amount: 800,
      description: "café",
      category: "comida",
    });
  });

  it("categorizes unknown items as 'otros'", () => {
    const result = parseExpenseRegex("gasté 1000 en flores");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("otros");
  });

  it("returns null for non-expense messages", () => {
    expect(parseExpenseRegex("hola cómo estás")).toBeNull();
    expect(parseExpenseRegex("qué onda")).toBeNull();
    expect(parseExpenseRegex("")).toBeNull();
  });

  it("handles messages with accents correctly", () => {
    const result = parseExpenseRegex("gasté 3000 en farmacia");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("salud");
  });
});
