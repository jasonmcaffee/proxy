"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const dotenv = require("dotenv");
async function bootstrap() {
    dotenv.config();
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.enableCors();
    const port = process.env.PORT || 80;
    console.log(`🚀 Proxy service starting on port ${port}...`);
    console.log(`📡 NextJS target: ${process.env.NEXTJS_TARGET || 'http://localhost:8080'}`);
    console.log(`📡 NestJS target: ${process.env.NESTJS_TARGET || 'http://localhost:8081'}`);
    await app.listen(port);
    console.log(`✅ Proxy service running on port ${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map