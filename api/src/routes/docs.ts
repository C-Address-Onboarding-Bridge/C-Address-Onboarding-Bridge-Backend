import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from '../openapi/spec';

export const docsRouter = Router();

docsRouter.get('/openapi.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(openApiSpec);
});

docsRouter.use('/docs', swaggerUi.serve);
docsRouter.get('/docs', swaggerUi.setup(openApiSpec, {
  customSiteTitle: 'C-Address Bridge API Docs',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
  },
}));
