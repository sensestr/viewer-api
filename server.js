/*
    @title: The viewer api for the Sensestr application.
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
const Axios = require('axios').default;
const io = require('socket.io-client')

Joi.objectId = require("joi-objectid")(Joi);

const mongoUsername = process.env.MONGO_USER || "sensestr";
const mongoPassword = process.env.MONGO_PASSWORD || ""
const mongoHost = process.env.MONGO_HOST || "sensestr-dev.io5pz.mongodb.net"
const mongoUrl = `mongodb+srv://${mongoUsername}:${mongoPassword}@${mongoHost}/viewer?retryWrites=true&w=majority`
const port = process.env.PORT || 3000
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const eventApiBase = process.env.EVENT_API_BASE;

const eventApiPlugin = {
  name: 'eventApi',
  version: '1.0.0',
  register: async function (server, options) {

    server.logger.info(options, "Registering the event API plugin.")

    const expose = {
      token: '',
      socket: null
    }

    const getToken = async function () {
      server.logger.info("Fetching token.")

      var requestOptions = {
        method: 'POST',
        url: 'https://sensestr-prod.us.auth0.com/oauth/token',
        headers: { 'content-type': 'application/json' },
        data: {
          grant_type: 'client_credentials',
          client_id: options.clientId,
          client_secret: options.clientSecret,
          audience: options.aud
        }
      };

      Axios.request(requestOptions).then(function (response) {
        server.logger.info(response.data, "Retrieved token.")
        expose.token = response.data['access_token'];
      }).catch(function (error) {
        server.logger.error(error.response.data, `Error fetching token.`)
      });

      setTimeout(getToken, options.refreshPeriod)
    }
    getToken()

    const getSocket = async function () {
      server.logger.info("Connecting to the event API socket.")
      const socket = io(options.eventApiBase, {path: '/events'})
      socket.on('connect', () => {
        server.logger.info({sid: socket.id}, `Connected to event API socket.`)
      })
      expose.socket = socket
    }
    getSocket()

    server.decorate('server', 'eventApi', expose);
    server.decorate('request', 'eventApi', expose);

  }
}

const init = async () => {
  const server = Hapi.server({
    port: port,
    host: "0.0.0.0",
    routes: {
      cors: {
        origin: ['*'], // an array of origins or 'ignore'
        headers: ['Authorization', 'Content-Type'], // an array of strings - 'Access-Control-Allow-Headers'
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
        prettyPrint: false,
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
    {
      plugin: eventApiPlugin,
      options: {
        clientId,
        clientSecret,
        aud: "https://api.sensestr.io",
        refreshPeriod: 3.5e7,
        eventApiBase
      }
    }
  ]);

  server.auth.strategy("auth0", "jwt", {
    keys: {
      uri: "https://sensestr-prod.us.auth0.com/.well-known/jwks.json",
      algorithms: ["RS256"],
    },
    verify: {
      aud: "https://api.sensestr.io",
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
        return h.response({ health: 'OK' })
      }
    }
  })

  server.route({
    method: "GET",
    path: "/viewers",
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
          .collection("viewers")
          .find(search)
          .skip(skip)
          .limit(limit);

        const count = await cursor.count({ applySkipLimit: true });
        const total = await cursor.count();
        const viewers = await cursor.toArray();

        viewers.map((viewer) => {
          viewer.id = viewer._id.toString();
          delete viewer._id;
        });

        return h.response({
          metadata: {
            count: count,
            skip: skip,
            limit: limit,
            total: total,
          },
          results: viewers,
        });

      },
      validate: {
        query: Joi.object({
          ownerId: Joi.string(),
          sessionId: Joi.objectId(),
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
              sessionId: Joi.objectId()
            })
          ),
        }),
      },
    },
  });

  server.route({
    method: "POST",
    path: "/viewers",
    options: {
      handler: async (request, h) => {
        const payload = request.payload;

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;
        const token = request.eventApi.token;
        const socket = request.eventApi.socket;

        const id = new ObjectID();
        const createdDate = new Date();
        const updatedDate = new Date();
        const creatorId = request.auth.credentials.user;

        let ownerId = payload.ownerId ? payload.ownerId : creatorId;

        if (
          payload.ownerId &&
          payload.ownerId !== creatorId &&
          (!request.auth.credentials.isMachine ||
            !request.auth.credentials.scopes.contains("impersonate_user"))
        ) {
          return h.response(
            Boom.unauthorized(
              "You cannot create a viewer for another user without the impersonate_user scope."
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

        // TODO check session in payload exist.

        const viewer = {
          _id: id,
          createdDate,
          updatedDate,
          creatorId: request.auth.credentials.user,
          updatorId: request.auth.credentials.user,
          ownerId,
          sessionId: payload.sessionId,
        };

        await db.collection("viewers").insertOne(viewer);

        viewer.id = id.toString();
        delete viewer._id;

        const event = {
          event: 'viewer created',
          token,
          viewerId: viewer.id,
          viewer
        }
        socket.emit(event.event, event)

        return h.response(viewer);
      },
      validate: {
        payload: Joi.object({
          ownerId: Joi.string(),
          sessionId: Joi.objectId(),
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
          sessionId: Joi.objectId(),
        }),
      },
    },
  });

  server.route({
    method: "GET",
    path: "/viewers/{id}",
    options: {
      handler: async (request, h) => {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;

        const id = request.params.id;
        const search = { _id: new ObjectID(id) };
        const viewer = await db.collection("viewers").findOne(search);

        if (viewer) {
          viewer.id = viewer._id.toString();
          delete viewer._id;
          return h.response(viewer);
        } else {
          return h.response(Boom.notFound(`Viewer with id ${id} not found.`));
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
          sessionId: Joi.objectId(),
        }),
      },
    },
  });

  server.route({
    method: "PUT",
    path: "/viewers/{id}",
    options: {
      handler: async (request, h) => {
        const payload = request.payload;

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;
        const token = request.eventApi.token;
        const socket = request.eventApi.socket;

        const id = request.params.id;
        const search = { _id: new ObjectID(id) };

        const viewer = await db.collection("viewers").findOne(search);

        if (viewer) {

          const updatedDate = new Date();
          const updatorId = request.auth.credentials.user;
          let ownerId = payload.ownerId ? payload.ownerId : viewer.ownerId;

          if (
            payload.ownerId &&
            payload.ownerId !== viewer.ownerId &&
            (!request.auth.credentials.isMachine ||
              !request.auth.credentials.scopes.contains("impersonate_user"))
          ) {
            return h.response(
              Boom.unauthorized(
                "You cannot change a viewer owner to another user without the impersonate_user scope."
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

          await db.collection("viewers").updateOne(search, {
            $set: {
              updatedDate,
              updatorId,
              ownerId,
              sessionId: payload.sessionId,
            },
          });

          const updatedViewer = {
            ...viewer,
            updatedDate,
            updatorId,
            ownerId,
            sessionId: payload.sessionId,
          }

          const event = {
            event: 'viewer updated',
            token,
            viewerId: updatedViewer.id,
            viewer: updatedViewer
          }
          socket.emit(event.event, event)

          // Merge the updated values with the existing object.
          return h.response(updatedViewer);

        } else {
          return h.response(Boom.notFound(`Viewer with id ${id} not found.`));
        }
      },
      validate: {
        params: Joi.object({
          id: Joi.objectId().required(),
        }),
        payload: Joi.object({
          ownerId: Joi.string(),
          sessionId: Joi.objectId(),
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
          sessionId: Joi.objectId(),
        }),
      },
    },
  });

  server.route({
    method: "DELETE",
    path: "/viewers/{id}",
    options: {
      handler: async (request, h) => {

        const db = request.mongo.db;
        const ObjectID = request.mongo.ObjectID;
        const token = request.eventApi.token;
        const socket = request.eventApi.socket;

        const id = request.params.id;

        const search = { _id: new ObjectID(id) };
        const viewer = await db.collection("viewers").findOne(search);

        if (viewer) {
          viewer.id = viewer._id.toString();
          delete viewer._id;

          await db.collection("viewers").deleteOne(search)

          const event = {
            event: 'viewer deleted',
            token,
            viewerId: viewer.id,
            viewer
          }
          socket.emit(event.event, event)

          return h.response(viewer);
        } else {
          return h.response(Boom.notFound(`Viewer with id ${id} not found.`));
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
          sessionId: Joi.objectId(),
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
