/*
    @title: The session service for the Sensestr application.
    @author: Piper Dougherty
    @email: doughertypiper@gmail.com

    @description:
        Doing it all in one file because, hey, microservices are all the rage these days!
*/

"use strict";

require('dotenv').config();

const Hapi = require("@hapi/hapi");
const Boom = require("@hapi/boom");
const Joi = require("joi");
const HapiMongoDB = require("hapi-mongodb");
const HapiPino = require("hapi-pino");
const HapiJwt = require("@hapi/jwt");

Joi.objectId = require("joi-objectid")(Joi);

const mongoUsername = process.env.MONGO_USER || "sensestr";
const mongoPassword = process.env.MONGO_PASSWORD || ""
const mongoHost = process.env.MONGO_HOST || "sensestr-dev.io5pz.mongodb.net"
const mongoUrl = `mongodb+srv://${mongoUsername}:${mongoPassword}@${mongoHost}/device?retryWrites=true&w=majority`

const init = async () => {
  const server = Hapi.server({
    port: 3000,
    host: "0.0.0.0",
    routes: {
      cors: {
          origin: ['*'], // an array of origins or 'ignore'
          headers: ['Authorization'], // an array of strings - 'Access-Control-Allow-Headers'
          exposedHeaders: ['Accept'], // an array of exposed headers - 'Access-Control-Expose-Headers',
          additionalExposedHeaders: ['Accept'], // an array of additional exposed headers
          maxAge: 60,
          credentials: true // boolean - 'Access-Control-Allow-Credentials'
      }
  }
  });

  await server.register([
    {
      plugin: HapiPino,
      options: {
        logPayload: true,
        logQueryParams: true,
        logRouteTags: true,
        logRequestStart: true,
        logRequestComplete: true,
        level: "debug",
        prettyPrint: true,
      },
    },
    {
      plugin: HapiMongoDB,
      options: {
        url: mongoUrl,
        settings: {
          poolSize: 10,
          useUnifiedTopology: true,
        },
        decorate: true,
      },
    },
    {
      plugin: HapiJwt,
    },
  ]);

  server.auth.strategy("auth0", "jwt", {
    keys: {
      uri: "https://sensestr-prod.us.auth0.com/.well-known/jwks.json",
      algorithms: ["RS256"],
    },
    verify: {
      aud: "https://sensestr.io/api",
      iss: "https://sensestr-prod.us.auth0.com/",
      sub: false,
    },
    validate: (artifacts, request, h) => {
      const token = artifacts.decoded.payload;
      const isMachine = token.gty === "client-credentials";
      return {
        isValid: true,
        credentials: {
          isMachine,
          user: token.sub,
          scopes: token.scopes || [],
          token,
        },
      };
    },
  });

  server.auth.default("auth0");

  server.route({
    method: "GET",
    path: "/health",
    options: {
      auth: false,
      handler: async (request, h) => {
        return h.response({health: 'OK'})
      }
    }
  })

  server.route({
    method: "GET",
    path: "/devices",
    options: {
      handler: async (request, h) => {
        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;
        const skip = request.query.skip;
        const limit = request.query.limit;
        const ownerId = request.query.ownerId;
        const sessionId = request.query.sessionId;
        const search = {};

        if (ownerId) {
          search.ownerId = ownerId
        }

        if (sessionId) {
          search.sessions = new ObjectID(sessionId);
        }

        const cursor = await request.mongo.db
          .collection("devices")
          .find(search)
          .skip(skip)
          .limit(limit);

        const count = await cursor.count({ applySkipLimit: true });
        const total = await cursor.count();
        const devices = await cursor.toArray();

        devices.map((device) => {
          device.id = device._id.toString();
          delete device._id;
        });

        return h.response({
          metadata: {
            count: count,
            skip: skip,
            limit: limit,
            total: total,
          },
          results: devices,
        });

      },
      validate: {
        query: Joi.object({
          sessionId: Joi.objectId(),
          ownerId: Joi.string(),
          skip: Joi.number().min(0).default(0),
          limit: Joi.number().min(1).max(100).default(25),
        }),
      },
      response: {
        schema: Joi.object({
          metadata: Joi.object({
            count: Joi.number(),
            skip: Joi.number(),
            limit: Joi.number(),
            total: Joi.number(),
          }),
          results: Joi.array().items(
            Joi.object({
              id: Joi.objectId(),
              createdDate: Joi.date().iso(),
              updatedDate: Joi.date().iso(),
              creatorId: Joi.string(),
              updatorId: Joi.string(),
              ownerId: Joi.string(),
              name: Joi.string().min(6).max(60).default("Unnamed Device"),
              description: Joi.string(),
              sessions: Joi.array().items(Joi.objectId())
            })
          ),
        }),
      },
    },
  });

  server.route({
    method: "POST",
    path: "/devices",
    options: {
      handler: async (request, h) => {
        const payload = request.payload;

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const id = new ObjectID();
        const createdDate = new Date();
        const updatedDate = new Date();

        let ownerId = payload.ownerId ? payload.ownerId : creatorId;

        if (
          payload.ownerId &&
          payload.ownerId !== creatorId &&
          (!request.auth.credentials.isMachine ||
            !request.auth.credentials.scopes.contains("impersonate_user"))
        ) {
          return h.response(
            Boom.unauthorized(
              "You cannot create a device for another user without the impersonate_user scope."
            )
          );
        }

        if (
          payload.ownerId &&
          payload.ownerId === request.auth.credentials.user &&
          request.auth.credentials.isMachine
        ) {
          return h.response(
            Boom.badRequest(
              "A machine cannot set themselves as the owner of this resource."
            )
          );
        }

        // TODO check sessions in payload exist.
        // TODO remove duplicate sessions in sessions list from device payload.

        const device = {
          _id: id,
          createdDate,
          updatedDate,
          creatorId: request.auth.credentials.user,
          updatorId: request.auth.credentials.user,
          ownerId,
          name: payload.name,
          description: payload.description,
          sessions: payload.sessions
        };

        await db.collection("devices").insertOne(device);

        device.id = id.toString();
        delete device._id;

        return h.response(device);
      },
      validate: {
        payload: Joi.object({
          ownerId: Joi.string(),
          name: Joi.string().min(6).max(60).default("Unnamed Device"),
          description: Joi.string(),
          sessions: Joi.array().items(Joi.objectId())
        }),
      },
      response: {
        schema: Joi.object({
          id: Joi.objectId(),
          createdDate: Joi.date().iso(),
          updatedDate: Joi.date().iso(),
          creatorId: Joi.string(),
          updatorId: Joi.string(),
          ownerId: Joi.string(),
          name: Joi.string().min(6).max(60).default("Unnamed Device"),
          description: Joi.string(),
          sessions: Joi.array().items(Joi.objectId())
        }),
      },
    },
  });

  server.route({
    method: "GET",
    path: "/devices/{id}",
    options: {
      handler: async (request, h) => {
        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const id = request.params.id;
        const search = { _id: new ObjectID(id) };
        const device = await db.collection("devices").findOne(search);

        if (device) {
          device.id = device._id.toString();
          delete device._id;
          return h.response(device);
        } else {
          return h.response(Boom.notFound(`Device with id ${id} not found.`));
        }
      },
      validate: {
        params: Joi.object({
          id: Joi.objectId(),
        }),
      },
      response: {
        schema: Joi.object({
          id: Joi.objectId(),
          createdDate: Joi.date().iso(),
          updatedDate: Joi.date().iso(),
          creatorId: Joi.string(),
          updatorId: Joi.string(),
          ownerId: Joi.string(),
          name: Joi.string().min(6).max(60).default("Unnamed Session"),
          description: Joi.string(),
          sessions: Joi.array().items(Joi.objectId())
        }),
      },
    },
  });

  server.route({
    method: "PUT",
    path: "/devices/{id}",
    options: {
      handler: async (request, h) => {
        const payload = request.payload;

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const id = request.params.id;
        const search = { _id: new ObjectID(id) };

        const device = await db.collection("devices").findOne(search);

        if (device) {

          const updatedDate = new Date();
          const updatorId = request.auth.credentials.user;
          let ownerId = payload.ownerId ? payload.ownerId : device.ownerId;
          const sessionSet = new Set(payload.sessions)
          const sessionIds = sessionSet.map(session => {new ObjectID(session)})

          if (
            payload.ownerId &&
            payload.ownerId !== device.ownerId &&
            (!request.auth.credentials.isMachine ||
              !request.auth.credentials.scopes.contains("impersonate_user"))
          ) {
            return h.response(
              Boom.unauthorized(
                "You cannot change a session owner to another user without the impersonate_user scope."
              )
            );
          }

          if (
            payload.ownerId &&
            payload.ownerId === request.auth.credentials.user &&
            request.auth.credentials.isMachine
          ) {
            return h.response(
              Boom.badRequest(
                "A machine cannot set themselves as the owner of this resource."
              )
            );
          }

          // TODO make sure that new sessions exist.
          // TODO remove duplicate sessions for sessions attribute in device payload.

          await db.collection("devices").updateOne(search, {
            $set: {
              updatedDate,
              updatorId,
              ownerId,
              name: payload.name,
              description: payload.description,
              sessions: sessionIds
            },
          });

          // Merge the updated values with the existing object.
          return h.response({
            ...device,
            updatedDate,
            updatorId,
            ownerId,
            name: payload.name,
            description: payload.description,
            sessions: [...sessionSet]
          });

        } else {
          return h.response(Boom.notFound(`Device with id ${id} not found.`));
        }
      },
      validate: {
        params: Joi.object({
          id: Joi.objectId().required(),
        }),
        payload: Joi.object({
          ownerId: Joi.string(),
          name: Joi.string().min(6).max(60).default("Unnamed Device"),
          description: Joi.string(),
          sessions: Joi.array().items(Joi.objectId())
        }),
      },
      response: {
        schema: Joi.object({
          id: Joi.objectId(),
          createdDate: Joi.date().iso(),
          updatedDate: Joi.date().iso(),
          creatorId: Joi.string(),
          updatorId: Joi.string(),
          ownerId: Joi.string(),
          name: Joi.string().min(6).max(60).default("Unnamed Device"),
          description: Joi.string(),
          sessions: Joi.array().items(Joi.objectId())
        }),
      },
    },
  });

  server.route({
    method: "DELETE",
    path: "/devices/{id}",
    options: {
      handler: async (request, h) => {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const id = request.params.id;

        const search = { _id: new ObjectID(id) };
        const device = await db.collection("devices").findOne(search);

        if (device) {
          device.id = device._id.toString();
          delete device._id;
          return h.response(device);
        } else {
          return h.response(Boom.notFound(`Device with id ${id} not found.`));
        }
      },
      validate: {
        params: Joi.object({
          id: Joi.objectId(),
        }),
      },
      response: {
        schema: Joi.object({
          id: Joi.objectId(),
          createdDate: Joi.date().iso(),
          updatedDate: Joi.date().iso(),
          creatorId: Joi.string(),
          updatorId: Joi.string(),
          ownerId: Joi.string(),
          name: Joi.string().min(6).max(60).default("Unnamed Device"),
          description: Joi.string(),
          sessions: Joi.array().items(Joi.objectId())
        }),
      },
    },
  });

  await server.start();
};

process.on("unhandledRejection", (err) => {
  console.log(err);
  process.exit(1);
});

init();
