"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
beforeAll(() => {
    process.env.NODE_ENV = 'test';
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(console, 'warn').mockImplementation(() => { });
    jest.spyOn(console, 'error').mockImplementation(() => { });
});
afterAll(() => {
    jest.restoreAllMocks();
});
jest.setTimeout(30000);
process.env.NEXTJS_TARGET = 'http://localhost:8081';
process.env.PORT = '3000';
//# sourceMappingURL=test-setup.js.map