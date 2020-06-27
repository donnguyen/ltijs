/* eslint-disable require-atomic-updates */
/* eslint-disable no-useless-escape */

/* Main class for the Provider functionalities */

const Server = require('../Utils/Server')
const Request = require('../Utils/Request')
const Platform = require('../Utils/Platform')
const Auth = require('../Utils/Auth')
const DB = require('../Utils/Database')
const Keyset = require('../Utils/Keyset')

const GradeService = require('./Services/Grade')
const DeepLinkingService = require('./Services/DeepLinking')
const NamesAndRolesService = require('./Services/NamesAndRoles')

const url = require('fast-url-parser')
const jwt = require('jsonwebtoken')

const provAuthDebug = require('debug')('provider:auth')
const provMainDebug = require('debug')('provider:main')

/**
 * @descripttion Exposes methods for easy manipulation of the LTI 1.3 standard as a LTI Provider and a "server" object to manipulate the Express instance
 */
class Provider {
  // Pre-initiated variables
  #loginRoute = '/login'

  #appRoute = '/'

  #sessionTimeoutRoute = '/sessionTimeout'

  #invalidTokenRoute = '/invalidToken'

  #keysetRoute = '/keys'

  #whitelistedRoutes = []

  #ENCRYPTIONKEY

  #devMode = false

  #tokenMaxAge = 10

  #cookieOptions = {
    secure: false,
    httpOnly: true,
    signed: true
  }

  #connectCallback = async (connection, req, res, next) => { return next() }

  #deepLinkingCallback = async (connection, req, res, next) => { return next() }

  #sessionTimeoutCallback = async (req, res) => {
    return res.status(401).send('Token invalid or expired. Please reinitiate login.')
  }

  #invalidTokenCallback = async (req, res) => {
    return res.status(401).send('Invalid token. Please reinitiate login.')
  }

  // Assembles and sends keyset
  #keyset = async (req, res) => {
    try {
      const keyset = await Keyset.build(this.Database, this.#ENCRYPTIONKEY)
      return res.status(200).send(keyset)
    } catch (err) {
      provMainDebug(err)
      res.sendStatus(500)
    }
  }

  #server

  /**
     * @description Provider configuration method.
     * @param {String} encryptionkey - Secret used to sign cookies and encrypt other info.
     * @param {Object} database - The Database configurations to open and manage connection, uses MongoDB Driver.
     * @param {String} [database.url] - Database Url (Ex: mongodb://localhost/applicationdb).
     * @param {Object} [database.plugin] - If set, must be the Database object of the desired database plugin.
     * @param {Object} [database.connection] - Database connection options (Ex: user, pass)
     * @param {String} [database.connection.user] - Database user for authentication if needed.
     * @param {String} [database.conenction.pass] - Database pass for authentication if needed.
     * @param {Object} [options] - Lti Provider additional options,.
     * @param {String} [options.appRoute = '/'] - Lti Provider main route. If no option is set '/' is used.
     * @param {String} [options.loginRoute = '/login'] - Lti Provider login route. If no option is set '/login' is used.
     * @param {String} [options.sessionTimeoutRoute = '/sessionTimeout'] - Lti Provider session timeout route. If no option is set '/sessionTimeout' is used.
     * @param {String} [options.invalidTokenRoute = '/invalidToken'] - Lti Provider invalid token route. If no option is set '/invalidToken' is used.
     * @param {String} [options.keysetRoute = '/keys'] - Lti Provider public jwk keyset route. If no option is set '/keys' is used.
     * @param {Boolean} [options.https = false] - Set this as true in development if you are not using any web server to redirect to your tool (like Nginx) as https and are planning to configure ssl locally. If you set this option as true you can enable the secure flag in the cookies options of the onConnect method.
     * @param {Object} [options.ssl] - SSL certificate and key if https is enabled.
     * @param {String} [options.ssl.key] - SSL key.
     * @param {String} [options.ssl.cert] - SSL certificate.
     * @param {String} [options.staticPath] - The path for the static files your application might serve (Ex: _dirname+"/public")
     * @param {Boolean} [options.cors = true] - If false, disables cors.
     * @param {Function} [options.serverAddon] - Allows the execution of a method inside of the server contructor. Can be used to register middlewares.
     * @param {Object} [options.cookies] - Cookie configuration. Allows you to configure, sameSite and secure parameters.
     * @param {Boolean} [options.cookies.secure = false] - Cookie secure parameter. If true, only allows cookies to be passed over https.
     * @param {String} [options.cookies.sameSite = 'Lax'] - Cookie sameSite parameter. If cookies are going to be set across domains, set this parameter to 'None'.
     * @param {Boolean} [options.devMode = false] - If true, does not require state and session cookies to be present (If present, they are still validated). This allows ltijs to work on development environments where cookies cannot be set. THIS SHOULD NOT BE USED IN A PRODUCTION ENVIRONMENT.
     * @param {Number} [options.tokenMaxAge = 10] - Sets the idToken max age allowed in seconds. Defaults to 10 seconds. If false, disables max age validation.
     */
  setup (encryptionkey, database, options) {
    if (options && options.https && (!options.ssl || !options.ssl.key || !options.ssl.cert)) throw new Error('No ssl Key  or Certificate found for local https configuration.')
    if (!encryptionkey) throw new Error('Encryptionkey parameter missing in options.')
    if (!database) throw new Error('Missing database configurations.')

    /**
     * @description Database object.
     */
    this.Database = null
    if (!database.plugin) this.Database = DB(database)
    else throw new Error('Database plugins are not yet supported with version 5.0 due to datbae structural changes.')

    if (options && (options.appRoute || options.appUrl)) this.#appRoute = options.appRoute || options.appUrl
    if (options && (options.loginRoute || options.loginUrl)) this.#loginRoute = options.loginRoute || options.loginUrl
    if (options && (options.sessionTimeoutRoute || options.sessionTimeoutUrl)) this.#sessionTimeoutRoute = options.sessionTimeoutRoute || options.sessionTimeoutUrl
    if (options && (options.invalidTokenRoute || options.invalidTokenUrl)) this.#invalidTokenRoute = options.invalidTokenRoute || options.invalidTokenUrl
    if (options && (options.keysetRoute || options.keysetUrl)) this.#keysetRoute = options.keysetRoute || options.keysetUrl

    if (options && options.devMode === true) this.#devMode = true
    if (options && options.tokenMaxAge !== undefined) this.#tokenMaxAge = options.tokenMaxAge

    // Cookie options
    if (options && options.cookies) {
      if (options.cookies.sameSite) {
        this.#cookieOptions.sameSite = options.cookies.sameSite
        if (options.cookies.sameSite.toLowerCase() === 'none') this.#cookieOptions.secure = true
      }
      if (options.cookies.secure === true) this.#cookieOptions.secure = true
    }

    this.#ENCRYPTIONKEY = encryptionkey

    this.#server = new Server(options ? options.https : false, options ? options.ssl : false, this.#ENCRYPTIONKEY, options ? options.cors : true, options ? options.serverAddon : false)

    /**
     * @description Express server object.
     */
    this.app = this.#server.app

    /**
     * @description Grading service.
     */
    this.Grade = new GradeService(this.getPlatform, this.#ENCRYPTIONKEY, this.Database)

    /**
     * @description Deep Linking service.
     */
    this.DeepLinking = new DeepLinkingService(this.getPlatform, this.#ENCRYPTIONKEY, this.Database)

    /**
     * @description Names and Roles service.
     */
    this.NamesAndRoles = new NamesAndRolesService(this.getPlatform, this.#ENCRYPTIONKEY, this.Database)

    if (options && options.staticPath) this.#server.setStaticPath(options.staticPath)

    // Registers main athentication and routing middleware
    const sessionValidator = async (req, res, next) => {
      provMainDebug('Receiving request at path: ' + req.baseUrl + req.path)
      // Ckeck if request is attempting to initiate oidc login flow or access reserved or whitelisted routes
      if (req.path === this.#loginRoute || req.path === this.#sessionTimeoutRoute || req.path === this.#invalidTokenRoute || req.path === this.#keysetRoute) return next()

      provMainDebug('Path does not match reserved endpoints')

      try {
        // Retrieving LTIK token
        const ltik = req.token
        // Retrieving cookies
        const cookies = req.signedCookies
        provMainDebug('Cookies received: ')
        provMainDebug(cookies)

        if (!ltik) {
          const idtoken = req.body.id_token
          if (idtoken) {
            // No ltik found but request contains an idtoken
            provMainDebug('Received idtoken for validation')

            // Retrieves state
            const state = req.body.state

            // Retrieving validation parameters from cookies
            provAuthDebug('Response state: ' + state)
            const validationCookie = cookies['state' + state]

            const validationParameters = {
              iss: validationCookie,
              maxAge: this.#tokenMaxAge
            }

            const valid = await Auth.validateToken(idtoken, this.#devMode, validationParameters, this.getPlatform, this.#ENCRYPTIONKEY, this.Database)

            // Deletes state validation cookie
            res.clearCookie('state' + state, this.#cookieOptions)

            provAuthDebug('Successfully validated token!')

            const courseId = valid['https://purl.imsglobal.org/spec/lti/claim/context'] ? valid['https://purl.imsglobal.org/spec/lti/claim/context'].id : 'NF'
            const resourceId = valid['https://purl.imsglobal.org/spec/lti/claim/resource_link'] ? valid['https://purl.imsglobal.org/spec/lti/claim/resource_link'].id : 'NF'
            const deploymentId = valid['https://purl.imsglobal.org/spec/lti/claim/deployment_id']

            const contextId = encodeURIComponent(valid.iss + deploymentId + courseId + '_' + resourceId)
            const platformCode = encodeURIComponent('lti' + Buffer.from(valid.iss + deploymentId).toString('base64'))

            // Mount platform token
            const platformToken = {
              iss: valid.iss,
              user: valid.sub,
              roles: valid['https://purl.imsglobal.org/spec/lti/claim/roles'],
              userInfo: {
                given_name: valid.given_name,
                family_name: valid.family_name,
                name: valid.name,
                email: valid.email
              },
              platformInfo: valid['https://purl.imsglobal.org/spec/lti/claim/tool_platform'],
              deploymentId: valid['https://purl.imsglobal.org/spec/lti/claim/deployment_id'],
              lis: valid['https://purl.imsglobal.org/spec/lti/claim/lis'],
              endpoint: valid['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'],
              namesRoles: valid['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice']
            }

            // Store idToken in database
            await this.Database.Replace(false, 'idtoken', { iss: valid.iss, deploymentId: deploymentId, user: valid.sub }, platformToken)

            // Mount context token
            const contextToken = {
              contextId: contextId,
              path: req.path,
              user: valid.sub,
              targetLinkUri: valid['https://purl.imsglobal.org/spec/lti/claim/target_link_uri'],
              context: valid['https://purl.imsglobal.org/spec/lti/claim/context'],
              resource: valid['https://purl.imsglobal.org/spec/lti/claim/resource_link'],
              custom: valid['https://purl.imsglobal.org/spec/lti/claim/custom'],
              launchPresentation: valid['https://purl.imsglobal.org/spec/lti/claim/launch_presentation'],
              messageType: valid['https://purl.imsglobal.org/spec/lti/claim/message_type'],
              version: valid['https://purl.imsglobal.org/spec/lti/claim/version'],
              deepLinkingSettings: valid['https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings']
            }

            // Store contextToken in database
            await this.Database.Replace(false, 'contexttoken', { contextId: contextId, user: valid.sub }, contextToken)

            // Creates platform session cookie
            res.cookie(platformCode, valid.sub, this.#cookieOptions)

            provMainDebug('Generating LTIK and redirecting to endpoint')
            const newLtikObj = {
              platformUrl: valid.iss,
              deploymentId: deploymentId,
              platformCode: platformCode,
              contextId: contextId,
              user: valid.sub,
              s: state // Added state to make unique ltiks
            }
            // Signing context token
            const newLtik = jwt.sign(newLtikObj, this.#ENCRYPTIONKEY)

            const query = new URLSearchParams(req.query)
            query.append('ltik', newLtik)
            const urlSearchParams = query.toString()

            return res.redirect(req.baseUrl + req.path + '?' + urlSearchParams)
          } else {
            if (this.#whitelistedRoutes.indexOf(req.path) !== -1 || this.#whitelistedRoutes.indexOf(req.path + '-method-' + req.method.toUpperCase()) !== -1) {
              provMainDebug('Accessing as whitelisted route')
              return next()
            }
            provMainDebug('No LTIK found')
            provMainDebug('Request body: ', req.body)
            return res.redirect(req.baseUrl + this.#invalidTokenRoute)
          }
        }

        provMainDebug('LTIK found')
        let validLtik
        try {
          validLtik = jwt.verify(ltik, this.#ENCRYPTIONKEY)
        } catch (err) {
          if (this.#whitelistedRoutes.indexOf(req.path) !== -1 || this.#whitelistedRoutes.indexOf(req.path + '-method-' + req.method.toUpperCase()) !== -1) {
            provMainDebug('Accessing as whitelisted route')
            return next()
          }
          throw new Error(err.message)
        }
        provMainDebug('LTIK successfully verified')

        const platformUrl = validLtik.platformUrl
        const platformCode = validLtik.platformCode
        const deploymentId = validLtik.deploymentId
        const contextId = validLtik.contextId
        let user = validLtik.user

        provMainDebug('Attempting to retrieve matching session cookie')
        const cookieUser = cookies[platformCode]
        if (!cookieUser) {
          if (!this.#devMode) user = false
          else { provMainDebug('Dev Mode enabled: Missing session cookies will be ignored') }
        } else if (user.toString() !== cookieUser.toString()) user = false

        if (user) {
          provAuthDebug('Valid session found')
          // Gets corresponding id token from database
          let idToken = await this.Database.Get(false, 'idtoken', { iss: platformUrl, deploymentId: deploymentId, user: user })
          if (!idToken) throw new Error('No id token found in database')
          idToken = idToken[0]

          // Gets correspondent context token from database
          let contextToken = await this.Database.Get(false, 'contexttoken', { contextId: contextId, user: user })
          if (!contextToken) throw new Error('No context token found in database')
          contextToken = contextToken[0]
          idToken.platformContext = contextToken

          // Creating local variables
          res.locals.context = contextToken
          res.locals.token = idToken
          res.locals.ltik = ltik

          provMainDebug('Passing request to next handler')
          return next()
        } else {
          provMainDebug('No session cookie found')
          provMainDebug('Request body: ', req.body)
          provMainDebug('Passing request to session timeout handler')
          return res.redirect(req.baseUrl + this.#sessionTimeoutRoute)
        }
      } catch (err) {
        provAuthDebug(err)
        provMainDebug('Passing request to invalid token handler')
        return res.redirect(req.baseUrl + this.#invalidTokenRoute)
      }
    }

    this.app.use(sessionValidator)

    this.app.all(this.#loginRoute, async (req, res) => {
      const params = { ...req.query, ...req.body }
      try {
        const iss = params.iss
        provMainDebug('Receiving a login request from: ' + iss)
        const platform = await this.getPlatform(iss)
        if (platform) {
          provMainDebug('Redirecting to platform authentication endpoint')

          // Create state parameter used to validade authentication response
          const state = encodeURIComponent([...Array(20)].map(_ => (Math.random() * 36 | 0).toString(36)).join``)
          provMainDebug('Generated state: ', state)

          // Setting up validation info
          const cookieOptions = JSON.parse(JSON.stringify(this.#cookieOptions))
          cookieOptions.maxAge = 60 * 10 * 1000 // Adding max age to state cookie = 10min
          res.cookie('state' + state, iss, cookieOptions)

          // Redirect to authentication endpoint
          const query = await Request.ltiAdvantageLogin(params, platform, state)
          provMainDebug('Login request: ')
          provMainDebug(query)
          res.redirect(url.format({
            pathname: await platform.platformAuthEndpoint(),
            query: query
          }))
        } else {
          provMainDebug('Unregistered platform attempting connection: ' + iss)
          return res.status(401).send('Unregistered platform.')
        }
      } catch (err) {
        provAuthDebug(err)
        res.sendStatus(400)
      }
    })

    // Session timeout, invalid token and keyset methods
    this.app.all(this.#sessionTimeoutRoute, async (req, res, next) => {
      this.#sessionTimeoutCallback(req, res, next)
    })
    this.app.all(this.#invalidTokenRoute, async (req, res, next) => {
      this.#invalidTokenCallback(req, res, next)
    })
    this.app.get(this.#keysetRoute, async (req, res, next) => {
      this.#keyset(req, res, next)
    })

    // Main app
    this.app.all(this.#appRoute, async (req, res, next) => {
      if (res.locals.context.messageType === 'LtiDeepLinkingRequest') return this.#deepLinkingCallback(res.locals.token, req, res, next)
      return this.#connectCallback(res.locals.token, req, res, next)
    })
  }

  /**
     * @description Starts listening to a given port for LTI requests and opens connection to the database.
     * @param {Object} [options] - Deployment options.
     * @param {Number} [options.port] - Deployment port. 3000 by default.
     * @param {Boolean} [options.silent] - If true, disables initial startup message.
     * @param {Boolean} [options.serverless] - If true, Ltijs does not start an Express server instance. This allows usage as a middleware and with services like AWS. Ignores 'port' parameter.
     * @returns {Promise<true| false>}
     */
  async deploy (options) {
    provMainDebug('Attempting to connect to database')
    try {
      await this.Database.setup()

      const conf = {
        port: 3000,
        silent: false
      }

      if (options && options.port) conf.port = options.port
      if (options && options.silent) conf.silent = options.silent
      // Starts server on given port

      if (options && options.serverless) console.log('Ltijs started in serverless mode...')
      else {
        await this.#server.listen(conf.port)
        provMainDebug('Ltijs started listening on port: ', conf.port)

        // Startup message
        const message = 'LTI Provider is listening on port ' + conf.port + '!\n\n LTI provider config: \n >App Route: ' + this.#appRoute + '\n >Initiate Login Route: ' + this.#loginRoute + '\n >Keyset Route: ' + this.#keysetRoute + '\n >Session Timeout Route: ' + this.#sessionTimeoutRoute + '\n >Invalid Token Route: ' + this.#invalidTokenRoute

        if (!conf.silent) {
          console.log('  _   _______ _____       _  _____\n' +
                      ' | | |__   __|_   _|     | |/ ____|\n' +
                      ' | |    | |    | |       | | (___  \n' +
                      ' | |    | |    | |   _   | |\\___ \\ \n' +
                      ' | |____| |   _| |_ | |__| |____) |\n' +
                      ' |______|_|  |_____(_)____/|_____/ \n\n', message)
        }
      }
      if (this.#devMode) console.log('\nStarting in Dev Mode, state validation and session cookies will not be required. THIS SHOULD NOT BE USED IN A PRODUCTION ENVIRONMENT!')

      // Sets up gracefull shutdown
      process.on('SIGINT', async () => {
        await this.close(options)
        process.exit()
      })

      return true
    } catch (err) {
      console.log('Error during deployment: ', err)
      await this.close(options)
      process.exit()
    }
  }

  /**
   * @description Closes connection to database and stops server.
   * @returns {Promise<true | false>}
   */
  async close (options) {
    if (!options || options.silent !== true) console.log('\nClosing server...')
    await this.#server.close()
    if (!options || options.silent !== true) console.log('Closing connection to the database...')
    await this.Database.Close()
    if (!options || options.silent !== true) console.log('Shutdown complete.')
    return true
  }

  /**
     * @description Sets the callback function called whenever there's a sucessfull lti 1.3 launch, exposing a "token" object containing the idtoken information.
     * @param {Function} _connectCallback - Callback function called everytime a platform sucessfully launches to the provider.
     * @example .onConnect((token, request, response)=>{response.send('OK')})
     * @returns {true}
     */
  onConnect (_connectCallback, options) {
    if (options) {
      if (options.sameSite || options.secure) console.log('Deprecation Warning: The optional parameters of the onConnect() method are now deprecated and will be removed in the 6.0 release. Cookie parameters can be found in the main Ltijs constructor options: ... { cookies: { secure: true, sameSite: \'None\' }.')

      if (options.sessionTimeout || options.invalidToken) console.log('Deprecation Warning: The optional parameters of the onConnect() method are now deprecated and will be removed in the 6.0 release. Invalid token and Session Timeout methods can now be set with the onSessionTimeout() and onInvalidToken() methods.')

      if (options.sameSite) {
        this.#cookieOptions.sameSite = options.sameSite
        if (options.sameSite.toLowerCase() === 'none') this.#cookieOptions.secure = true
      }
      if (options.secure === true) this.#cookieOptions.secure = true
      if (options.sessionTimeout) this.#sessionTimeoutCallback = options.sessionTimeout
      if (options.invalidToken) this.#invalidTokenCallback = options.invalidToken
    }

    if (_connectCallback) {
      this.#connectCallback = _connectCallback
      return true
    }
    throw new Error('MissingCallback')
  }

  /**
   * @description Sets the callback function called whenever there's a sucessfull deep linking launch, exposing a "token" object containing the idtoken information.
   * @param {Function} _deepLinkingCallback - Callback function called everytime a platform sucessfully launches a deep linking request.
   * @example .onDeepLinking((token, request, response)=>{response.send('OK')})
   * @returns {true}
   */
  onDeepLinking (_deepLinkingCallback) {
    if (_deepLinkingCallback) {
      this.#deepLinkingCallback = _deepLinkingCallback
      return true
    }
    throw new Error('MissingCallback')
  }

  /**
   * @description Sets the callback function called when no valid session is found during a request validation.
   * @param {Function} _sessionTimeoutCallback - Callback method.
   * @example .onSessionTimeout((request, response)=>{response.send('Session timeout')})
   * @returns {true}
   */
  onSessionTimeout (_sessionTimeoutCallback) {
    if (_sessionTimeoutCallback) {
      this.#sessionTimeoutCallback = _sessionTimeoutCallback
      return true
    }
    throw new Error('MissingCallback')
  }

  /**
   * @description Sets the callback function called when the token received fails to be validated.
   * @param {Function} _invalidTokenCallback - Callback method.
   * @example .onInvalidToken((request, response)=>{response.send('Invalid token')})
   * @returns {true}
   */
  onInvalidToken (_invalidTokenCallback) {
    if (_invalidTokenCallback) {
      this.#invalidTokenCallback = _invalidTokenCallback
      return true
    }
    throw new Error('MissingCallback')
  }

  /**
   * @description Gets the main application route that will receive the final decoded Idtoken at the end of a successful launch.
   * @returns {String}
   */
  appRoute () {
    return this.#appRoute
  }

  /**
   * @description Gets the login route responsible for dealing with the OIDC login flow.
   * @returns {String}
   */
  loginRoute () {
    return this.#loginRoute
  }

  /**
     * @description Gets the session timeout route that will be called whenever the system encounters a session timeout.
     * @returns {String}
     */
  sessionTimeoutRoute () {
    return this.#sessionTimeoutRoute
  }

  /**
     * @description Gets the invalid token route that will be called whenever the system encounters a invalid token or cookie.
     * @returns {String}
     */
  invalidTokenRoute () {
    return this.#invalidTokenRoute
  }

  /**
     * @description Gets the keyset route that will be used to retrieve a public jwk keyset.
     * @returns {String}
     */
  keysetRoute () {
    return this.#keysetRoute
  }

  /**
   * @description Whitelists routes to bypass the lti 1.3 authentication protocol. These routes dont have access to a idtoken
   * @param {String} routes - Routes to be whitelisted
   */
  whitelist (...routes) {
    if (!routes) throw new Error('No route passed.')
    const formattedRoutes = []
    for (const route of routes) {
      const isObject = route === Object(route)
      if (isObject) {
        if (!route.route || !route.method) throw new Error('Wrong object format on route. Expects string ("/route") or object ({ route: "/route", method: "POST" })')
        formattedRoutes.push(route.route + '-method-' + route.method.toUpperCase())
      } else formattedRoutes.push(route)
    }
    this.#whitelistedRoutes = formattedRoutes
    return true
  }

  /**
     * @description Registers a platform.
     * @param {Object} platform
     * @param {String} platform.url - Platform url.
     * @param {String} platform.name - Platform nickname.
     * @param {String} platform.clientId - Client Id generated by the platform.
     * @param {String} platform.authenticationEndpoint - Authentication endpoint that the tool will use to authenticate within the platform.
     * @param {String} platform.accesstokenEndpoint - Access token endpoint that the tool will use to get an access token for the platform.
     * @param {object} platform.authConfig - Authentication method and key for verifying messages from the platform. {method: "RSA_KEY", key:"PUBLIC KEY..."}
     * @param {String} platform.authConfig.method - Method of authorization "RSA_KEY" or "JWK_KEY" or "JWK_SET".
     * @param {String} platform.authConfig.key - Either the RSA public key provided by the platform, or the JWK key, or the JWK keyset address.
     * @returns {Promise<Platform|false>}
     */
  async registerPlatform (platform) {
    if (!platform || !platform.url) throw new Error('Error. Missing platform Url.')
    let kid
    try {
      const _platform = await this.getPlatform(platform.url)

      if (!_platform) {
        if (!platform.name || !platform.clientId || !platform.authenticationEndpoint || !platform.accesstokenEndpoint || !platform.authConfig) throw new Error('Error registering platform. Missing arguments.')
        kid = await Auth.generateProviderKeyPair(this.#ENCRYPTIONKEY, this.Database, platform.url)
        const plat = new Platform(platform.name, platform.url, platform.clientId, platform.authenticationEndpoint, platform.accesstokenEndpoint, kid, this.#ENCRYPTIONKEY, platform.authConfig, this.Database)

        // Save platform to db
        provMainDebug('Registering new platform: ' + platform.url)
        await this.Database.Replace(false, 'platform', { platformUrl: platform.url }, { platformName: platform.name, platformUrl: platform.url, clientId: platform.clientId, authEndpoint: platform.authenticationEndpoint, accesstokenEndpoint: platform.accesstokenEndpoint, kid: kid, authConfig: platform.authConfig })

        return plat
      } else {
        provMainDebug('Platform already registered.')
        await this.Database.Modify(false, 'platform', { platformUrl: platform.url }, { platformName: platform.name || await _platform.platformName(), clientId: platform.clientId || await _platform.platformClientId(), authEndpoint: platform.authenticationEndpoint || await _platform.platformAuthEndpoint(), accesstokenEndpoint: platform.accesstokenEndpoint || await _platform.platformAccessTokenEndpoint(), authConfig: platform.authConfig || await _platform.platformAuthConfig() })
        return _platform
      }
    } catch (err) {
      await this.Database.Delete('publickey', { kid: kid })
      await this.Database.Delete('privatekey', { kid: kid })
      await this.Database.Delete('platform', { platformUrl: platform.url })
      provMainDebug(err.message)
      throw new Error(err)
    }
  }

  /**
     * @description Gets a platform.
     * @param {String} url - Platform url.
     * @returns {Promise<Platform | false>}
     */
  async getPlatform (url, ENCRYPTIONKEY, Database) {
    if (!url) throw new Error('No url provided')

    const plat = Database !== undefined ? await Database.Get(false, 'platform', { platformUrl: url }) : await this.Database.Get(false, 'platform', { platformUrl: url })

    if (!plat) return false
    const obj = plat[0]

    if (!obj) return false
    const result = new Platform(obj.platformName, obj.platformUrl, obj.clientId, obj.authEndpoint, obj.accesstokenEndpoint, obj.kid, ENCRYPTIONKEY !== undefined ? ENCRYPTIONKEY : this.#ENCRYPTIONKEY, obj.authConfig, Database !== undefined ? Database : this.Database)

    return result
  }

  /**
     * @description Deletes a platform.
     * @param {string} url - Platform url.
     * @returns {Promise<true | false>}
     */
  async deletePlatform (url) {
    if (!url) throw new Error('No url provided')
    const platform = await this.getPlatform(url)
    if (platform) return platform.remove()
    return false
  }

  /**
     * @description Gets all platforms.
     * @returns {Promise<Array<Platform>| false>}
     */
  async getAllPlatforms () {
    const returnArray = []
    const platforms = await this.Database.Get(false, 'platform')

    if (platforms) {
      for (const obj of platforms) returnArray.push(new Platform(obj.platformName, obj.platformUrl, obj.clientId, obj.authEndpoint, obj.accesstokenEndpoint, obj.kid, this.#ENCRYPTIONKEY, obj.authConfig, this.Database))
      return returnArray
    }
    return []
  }

  /**
   * @description Redirect to a new location and sets path variable if the location represents a separate resource.
   * @param {Object} res - Express response object.
   * @param {String} path - Redirect path.
   * @param {Object} [options] - Redirection options.
   * @param {Boolean} [options.isNewResource = false] - If true, changes the path variable on the context token.
   * @example lti.redirect(response, '/path', { isNewResource: true })
   */
  async redirect (res, path, options) {
    if (!res.locals.token) return res.redirect(path) // If no token is present, just redirects
    provMainDebug('Redirecting to: ', path)
    const token = res.locals.token
    const pathParts = url.parse(path)

    // Updates path variable if this is a new resource
    if ((options && options.isNewResource)) {
      provMainDebug('Changing context token path to: ' + path)
      await this.Database.Modify(false, 'contexttoken', { contextId: token.platformContext.contextId, user: res.locals.token.user }, { path: path })
    }

    // Formatting path with queries
    const params = new URLSearchParams(pathParts.search)
    const queries = {}
    for (const [key, value] of params) { queries[key] = value }

    // Fixing fast-url-parser bug where port gets assigned to pathname if there's no path
    const portMatch = pathParts.pathname.match(/:[0-9]*/)
    if (portMatch) {
      pathParts.port = portMatch[0].split(':')[1]
      pathParts.pathname = pathParts.pathname.split(portMatch[0]).join('')
    }
    const formattedPath = url.format({
      protocol: pathParts.protocol,
      hostname: pathParts.hostname,
      pathname: pathParts.pathname,
      port: pathParts.port,
      auth: pathParts.auth,
      query: {
        ...queries,
        ltik: res.locals.ltik
      }
    })

    // Redirects to path with queries
    return res.redirect(formattedPath)
  }

  // Deprecated methods, these methods will be removed in version 6.0

  /**
   * @deprecated
   */
  appUrl () {
    console.log('Deprecation warning: The appUrl() method is now deprecated and will be removed in the 6.0 release. Use appRoute() instead.')
    return this.appRoute()
  }

  /**
   * @deprecated
   */
  loginUrl () {
    console.log('Deprecation warning: The loginUrl() method is now deprecated and will be removed in the 6.0 release. Use loginRoute() instead.')
    return this.loginRoute()
  }

  /**
   * @deprecated
   */
  sessionTimeoutUrl () {
    console.log('Deprecation warning: The sessionTimeoutUrl() method is now deprecated and will be removed in the 6.0 release. Use sessionTimeoutRoute() instead.')
    return this.sessionTimeoutRoute()
  }

  /**
   * @deprecated
   */
  invalidTokenUrl () {
    console.log('Deprecation warning: The invalidTokenUrl() method is now deprecated and will be removed in the 6.0 release. Use invalidTokenRoute() instead.')
    return this.invalidTokenRoute()
  }

  /**
   * @deprecated
   */
  keysetUrl () {
    console.log('Deprecation warning: The keysetUrl() method is now deprecated and will be removed in the 6.0 release. Use keysetRoute() instead.')
    return this.keysetRoute()
  }
}

module.exports = new Provider()
