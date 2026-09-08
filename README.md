# CHEBROX Inventario

## Requisitos

- Node.js 18 o superior
- MySQL 8 o superior

## Puesta en marcha

1. Instala dependencias: `npm install`
2. Crea la base de datos ejecutando `schema.sql` en MySQL.
3. Copia `.env.example` como `.env` y completa las credenciales.
4. Inicia el sistema con `npm start`.
5. Abre `http://localhost:3000`.

El PIN de acceso se configura con `CHEBROX_PIN`; por defecto es `2026`.

## API

- `POST /api/auth/login`
- `GET /api/bootstrap`
- `GET|POST|DELETE /api/providers`
- `GET|POST|PUT|DELETE /api/products`
- `DELETE /api/products`
- `GET|POST|PUT|DELETE /api/orders`

El navegador ya no necesita leer ni escribir inventario, proveedores o pedidos en `localStorage`; esos datos se almacenan en MySQL.
# progreso
