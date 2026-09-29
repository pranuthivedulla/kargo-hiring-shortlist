/**
 * Import this FIRST, before any ../lib/ import.
 *
 * ES module imports are hoisted and evaluated before ordinary statements, so
 * assigning process.env.DATA_DIR at the top of a test file happens too late —
 * lib/paths.ts has already read it. A side-effect module in the import list
 * runs in order, which is early enough.
 *
 * Without this, the test suite ingests the real candidates' CVs and, with
 * DATABASE_URL set, writes them to the production database.
 */
process.env.DATA_DIR = "data/_fixtures";
