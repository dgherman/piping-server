import * as http from "http";
import * as multiparty from "multiparty";
import * as pkginfo from "pkginfo";
import {ParsedUrlQuery} from "querystring";
import * as stream from "stream";
import * as url from "url";

import * as path from "path";
import {opt, optMap} from "./utils";

// Set module.exports.version
pkginfo(module, "version");

// Get version
// (from: https://stackoverflow.com/a/22339262/2885946)
const VERSION: string = module.exports.version;

type ReqRes = {
  readonly req: http.IncomingMessage,
  readonly res: http.ServerResponse
};

type Pipe = {
  readonly sender: ReqRes;
  readonly receivers: ReqRes[];
};

type ReqResAndUnsubscribe = {
  reqRes: ReqRes,
  unsubscribeCloseListener: () => void
};

type UnestablishedPipe = {
  sender?: ReqResAndUnsubscribe;
  receivers: ReqResAndUnsubscribe[];
  nReceivers: number;
};

/**
 * Convert unestablished pipe to pipe if it is established
 * @param p
 */
function getPipeIfEstablished(p: UnestablishedPipe): Pipe | undefined {
  if (p.sender !== undefined && p.receivers.length === p.nReceivers) {
    return {
      sender: p.sender.reqRes,
      receivers: p.receivers.map((r) => {
        // Unsubscribe on-close handlers
        // NOTE: this operation has side-effect
        r.unsubscribeCloseListener();
        return r.reqRes;
      })
    };
  } else {
    return undefined;
  }
}

/**
 * Return a if a is number otherwise return b
 * @param a
 * @param b
 */
function nanOrElse<T>(a: number, b: number): number {
  if (isNaN(a)) {
    return b;
  } else {
    return a;
  }
}

// Name to reserved path
const NAME_TO_RESERVED_PATH = {
  index: "/",
  version: "/version",
  help: "/help"
};

const indexPage: string =
`<html>
<head>
  <title>Piping</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    h3 {
      margin-top: 2em;
      margin-bottom: 0.5em;
    }
  </style>
</head>
<body>
  <h1>Piping</h1>
  Streaming file sending/receiving
  <form method="POST" id="file_form" enctype="multipart/form-data">
    <h3>Step 1: Choose a file or text</h3>

    <input type="checkbox" id="inputMode" onchange="toggleInputMode()">: <b>Text mode</b><br><br>

    <input type="file" name="input_file">
    <textarea type="text" name="input_text" placeholder="Input text" cols="30" rows="10"></textarea>
    <br>

    <h3>Step 2: Write your secret path</h3>
    (e.g. "abcd1234", "mysecret.png?n=3")<br>
    <input id="secret_path" placeholder="Secret path" size="50"><br>
    <h3>Step 3: Click the submit button</h3>
    <input type="submit">
  </form>
  <hr>
  Command-line usage:
  <a href="https://github.com/nwtgck/piping-server#readme">
    https://github.com/nwtgck/piping-server#readme
  </a><br>
  <script>
    // Set secret path action routing
    (function () {
      var fileForm = document.getElementById("file_form");
      var secretPathInput = document.getElementById("secret_path");
      secretPathInput.onkeyup = function(){
        fileForm.action = "/" + secretPathInput.value;
      };
    })();

    // Toggle input mode: file or text
    var toggleInputMode = (function () {
      var fileInput   = document.getElementsByName("input_file")[0];
      var textInput   = document.getElementsByName("input_text")[0];
      var activeInput = fileInput;
      var deactivatedInput = textInput;

      // Set inputs' functionality and visibility
      function setInputs() {
        activeInput.disabled = false;
        activeInput.style.display = null;

        deactivatedInput.disabled = true;
        deactivatedInput.style.display = "none";
      }
      setInputs();

      // Body of toggleInputMode
      function toggle() {
        // Swap inputs
        var tmpInput     = activeInput;
        activeInput      = deactivatedInput;
        deactivatedInput = tmpInput;
        setInputs();
      }
      return toggle;
    })();
  </script>
</body>
</html>
`;

/**
 * Generate help page
 * @param {string} url
 * @returns {string}
 */
// tslint:disable-next-line:no-shadowed-variable
function generateHelpPage(url: string): string {
  return (
`Help for piping-server ${VERSION}
(Repository: https://github.com/nwtgck/piping-server)

======= Get  =======
curl ${url}/mypath

======= Send =======
# Send a file
curl -T myfile ${url}/mypath

# Send a text
echo 'hello!' | curl -T - ${url}/mypath

# Send a directory (zip)
zip -q -r - ./mydir | curl -T - ${url}/mypath

# Send a directory (tar.gz)
tar zfcp - ./mydir | curl -T - ${url}/mypath

# Encryption
## Send
cat myfile | openssl aes-256-cbc | curl -T - ${url}/mypath
## Get
curl ${url}/mypath | openssl aes-256-cbc -d
`);
}

// All reserved paths
const RESERVED_PATHS: string[] =
  Object.values(NAME_TO_RESERVED_PATH);

export class Server {

  /** Get the number of receivers
   * @param {string | undefined} reqUrl
   * @returns {number}
   */
  private static getNReceivers(reqUrl: string | undefined): number {
    // Get query parameter
    const query = opt(optMap(url.parse, reqUrl, true).query);
    // The number receivers
    const nReceivers: number = nanOrElse(parseInt((query as ParsedUrlQuery).n as string, 10), 1);
    return nReceivers;
  }
  private readonly pathToEstablished: {[path: string]: boolean} = {};
  private readonly pathToUnestablishedPipe: {[path: string]: UnestablishedPipe} = {};

  /**
   *
   * @param enableLog Enable logging
   */
  constructor(readonly enableLog: boolean) {
  }

  public generateHandler(useHttps: boolean): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Get path name
      const reqPath: string =
          path.resolve(
              "/",
              opt(optMap(url.parse, opt(req.url)).pathname)
              // Remove last "/"
              .replace(/\/$/, "")
          );
      if (this.enableLog) {
        console.log(req.method, reqPath);
      }

      switch (req.method) {
        case "POST":
        case "PUT":
          if (RESERVED_PATHS.includes(reqPath)) {
            res.writeHead(400);
            res.end(`[ERROR] Cannot send to a reserved path '${reqPath}'. (e.g. '/mypath123')\n`);
          } else {
            // Handle a sender
            this.handleSender(req, res, reqPath);
          }
          break;
        case "GET":
          switch (reqPath) {
            case NAME_TO_RESERVED_PATH.index:
              res.end(indexPage);
              break;
            case NAME_TO_RESERVED_PATH.version:
              res.end(VERSION + "\n");
              break;
            case NAME_TO_RESERVED_PATH.help:
              // x-forwarded-proto is https or not
              const xForwardedProtoIsHttps: boolean = (() => {
                const proto = req.headers["x-forwarded-proto"];
                // NOTE: includes() is for supporting Glitch
                return proto !== undefined && proto.includes("https");
              })();
              const scheme: string = (useHttps || xForwardedProtoIsHttps) ? "https" : "http";
              // NOTE: req.headers.host contains port number
              const hostname: string = req.headers.host || "hostname";
              // tslint:disable-next-line:no-shadowed-variable
              const url = `${scheme}://${hostname}`;
              res.end(generateHelpPage(url));
              break;
            default:
              // Handle a receiver
              this.handleReceiver(req, res, reqPath);
              break;
          }
          break;
        default:
          res.end(`Error: Unsupported method: ${req.method}\n`);
          break;
      }
    };
  }

  /**
   * Start data transfer
   *
   * @param path
   * @param pipe
   */
  // tslint:disable-next-line:no-shadowed-variable
  private async runPipe(path: string, pipe: Pipe): Promise<void> {
    // Set established as true
    this.pathToEstablished[path] = true;
    // Delete unestablished pipe
    delete this.pathToUnestablishedPipe[path];

    const {sender, receivers} = pipe;

    const isMultipart: boolean = (sender.req.headers["content-type"] || "").includes("multipart/form-data");

    const part: multiparty.Part | undefined =
      isMultipart ?
        await new Promise((resolve, reject) => {
          const form = new multiparty.Form();
          form.once("part", (p: multiparty.Part) => {
            resolve(p);
          });
          form.parse(sender.req);
        }) :
        undefined;

    const senderData: NodeJS.ReadableStream =
      part === undefined ? sender.req : part;

    let closeCount: number = 0;
    for (const receiver of receivers) {
      // Close receiver
      const closeReceiver = (): void => {
        closeCount += 1;
        senderData.unpipe(passThrough);
        // If close-count is # of receivers
        if (closeCount === receivers.length) {
          sender.res.end("[INFO] All receiver(s) was/were closed halfway.\n");
          delete this.pathToEstablished[path];
          // Close sender
          sender.req.connection.destroy();
        }
      };

      const headers: http.OutgoingHttpHeaders =
        // If not multi-part sending
        part === undefined ?
          {
            // Add Content-Length if it exists
            ...(
              sender.req.headers["content-length"] === undefined ?
                {} : {"Content-Length": sender.req.headers["content-length"]}
            ),
            // Add Content-Type if it exists
            ...(
              sender.req.headers["content-type"] === undefined ?
                {} : {"Content-Type": sender.req.headers["content-type"]}
            )
          } :
          {
            // Add Content-Length if it exists
            ...(
              part.byteCount === undefined ?
                {} : {"Content-Length": part.byteCount}
            ),
            ...(
              part.headers["content-type"] === undefined ?
                {} : {"Content-Type": part.headers["content-type"]}
            )
          };

      // Write headers to a receiver
      receiver.res.writeHead(200, headers);

      const passThrough = new stream.PassThrough();
      senderData.pipe(passThrough);
      passThrough.pipe(receiver.res);
      receiver.req.on("close", () => {
        if (this.enableLog) {
          console.log("on-close");
        }
        closeReceiver();
      });
      receiver.req.on("error", (err) => {
        if (this.enableLog) {
          console.log("on-error");
        }
        closeReceiver();
      });
    }

    senderData.on("close", () => {
      if (this.enableLog) {
        console.log("sender on-close");
      }
      for (const receiver of receivers) {
        // Close a receiver
        receiver.res.connection.destroy();
      }
    });

    senderData.on("end", () => {
      sender.res.end("[INFO] Sending Successful!\n");
      // Delete from established
      delete this.pathToEstablished[path];
    });

    senderData.on("error", (error) => {
      sender.res.end("[ERROR] Sending Failed.\n");
      // Delete from established
      delete this.pathToEstablished[path];
    });
  }

  /**
   * Handle a sender
   * @param {"http".IncomingMessage} req
   * @param {"http".ServerResponse} res
   * @param {string} reqPath
   */
  private handleSender(req: http.IncomingMessage, res: http.ServerResponse, reqPath: string): void {
    // Get the number of receivers
    const nReceivers = Server.getNReceivers(req.url);
    // If the number of receivers is invalid
    if (nReceivers <= 0) {
      res.writeHead(400);
      res.end(`[ERROR] n should > 0, but n = ${nReceivers}.\n`);
    } else if (reqPath in this.pathToEstablished) {
      res.writeHead(400);
      res.end(`[ERROR] Connection on '${reqPath}' has been established already.\n`);
    } else {
      if (this.enableLog) {
        console.log(this.pathToUnestablishedPipe);
      }
      // If the path connection is connecting
      if (reqPath in this.pathToUnestablishedPipe) {
        // Get unestablished pipe
        const unestablishedPipe: UnestablishedPipe = this.pathToUnestablishedPipe[reqPath];
        // If a sender have not been registered yet
        if (unestablishedPipe.sender === undefined) {
          // If the number of receivers is the same size as connecting pipe's one
          if (nReceivers === unestablishedPipe.nReceivers) {
            // Register the sender
            unestablishedPipe.sender = this.createSenderOrReceiver("sender", req, res, reqPath);
            // Send waiting message
            res.write(`[INFO] Waiting for ${nReceivers} receiver(s)...\n`);
            // Send the number of receivers information
            res.write(`[INFO] ${unestablishedPipe.receivers.length} receiver(s) has/have been connected.\n`);
            // Get pipeOpt if established
            const pipe: Pipe | undefined =
              getPipeIfEstablished(unestablishedPipe);

            if (pipe !== undefined) {
              // Emit message to sender
              res.write("Start sending!\n");
              // Start data transfer
              this.runPipe(reqPath, pipe);
            }
          } else {
            res.writeHead(400);
            res.end(`Error: The number of receivers should be ${unestablishedPipe.nReceivers} but ${nReceivers}.\n`);
          }
        } else {
          res.writeHead(400);
          res.end(`[ERROR] Another sender has been registered on '${reqPath}'.\n`);
        }
      } else {
        // Send waiting message
        res.write(`[INFO] Waiting for ${nReceivers} receiver(s)...\n`);
        // Create a sender
        const sender = this.createSenderOrReceiver("sender", req, res, reqPath);
        // Register new unestablished pipe
        this.pathToUnestablishedPipe[reqPath] = {
          sender: sender,
          receivers: [],
          nReceivers: nReceivers
        };
      }
    }
  }

  /**
   * Handle a receiver
   * @param {"http".IncomingMessage} req
   * @param {"http".ServerResponse} res
   * @param {string} reqPath
   */
  private handleReceiver(req: http.IncomingMessage, res: http.ServerResponse, reqPath: string): void {
    // Get the number of receivers
    const nReceivers = Server.getNReceivers(req.url);
    // If the number of receivers is invalid
    if (nReceivers <= 0) {
      res.writeHead(400);
      res.end(`[ERROR] n should > 0, but n = ${nReceivers}.\n`);
    } else if (reqPath in this.pathToEstablished) {
      res.writeHead(400);
      res.end(`Error: Connection on '${reqPath}' has been established already.\n`);
    } else {
      // If the path connection is connecting
      if (reqPath in this.pathToUnestablishedPipe) {
        // Get unestablishedPipe
        const unestablishedPipe: UnestablishedPipe = this.pathToUnestablishedPipe[reqPath];
        // If the number of receivers is the same size as connecting pipe's one
        if (nReceivers === unestablishedPipe.nReceivers) {
          // If more receivers can connect
          if (unestablishedPipe.receivers.length < unestablishedPipe.nReceivers) {
            // Create a receiver
            const receiver = this.createSenderOrReceiver("receiver", req, res, reqPath);
            // Append new receiver
            unestablishedPipe.receivers.push(receiver);

            if (unestablishedPipe.sender !== undefined) {
              // Send connection message to the sender
              unestablishedPipe.sender.reqRes.res.write("[INFO] A receiver was connected.\n");
            }

            // Get pipeOpt if established
            const pipe: Pipe | undefined =
              getPipeIfEstablished(unestablishedPipe);

            if (pipe !== undefined) {
              // Emit message to sender
              pipe.sender.res.write(`[INFO] Start sending with ${pipe.receivers.length} receiver(s)!\n`);
              // Start data transfer
              this.runPipe(reqPath, pipe);
            }
          } else {
            res.writeHead(400);
            res.end("Error: The number of receivers has reached limits.\n");
          }
        } else {
          res.writeHead(400);
          res.end(`Error: The number of receivers should be ${unestablishedPipe.nReceivers} but ${nReceivers}.\n`);
        }
      } else {
        // Create a receiver
        const receiver = this.createSenderOrReceiver("receiver", req, res, reqPath);
        // Set a receiver
        this.pathToUnestablishedPipe[reqPath] = {
          receivers: [receiver],
          nReceivers: nReceivers
        };
      }
    }
  }

  /**
   * Create a sender or receiver
   *
   * Main purpose of this method is creating sender/receiver which unregisters unestablished pipe before establish
   *
   * @param removerType
   * @param req
   * @param res
   * @param reqPath
   */
  private createSenderOrReceiver(
    removerType: "sender" | "receiver",
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reqPath: string
  ): ReqResAndUnsubscribe {
    // Create receiver req&res
    const receiverReqRes: ReqRes = {req: req, res: res};
    // Define on-close handler
    const closeListener = () => {
      // If reqPath is registered
      if (reqPath in this.pathToUnestablishedPipe) {
        // Get unestablished pipe
        const unestablishedPipe = this.pathToUnestablishedPipe[reqPath];
        // Get sender/receiver remover
        const remover =
          removerType === "sender" ?
            (): boolean => {
              // If sender is defined
              if (unestablishedPipe.sender !== undefined) {
                // Remove sender
                unestablishedPipe.sender = undefined;
                return true;
              }
              return false;
            } :
            (): boolean => {
              // Get receivers
              const receivers = unestablishedPipe.receivers;
              // Find receiver's index
              const idx = receivers.findIndex((r) => r.reqRes === receiverReqRes);
              // If receiver is found
              if (idx !== -1) {
                // Delete the receiver from the receivers
                receivers.splice(idx, 1);
                return true;
              }
              return false;
            };
        // Remove a sender or receiver
        const removed: boolean = remover();
        // If removed
        if (removed) {
          // If unestablished pipe has no sender and no receivers
          if (unestablishedPipe.receivers.length === 0 && unestablishedPipe.sender === undefined) {
            // Remove unestablished pipe
            delete this.pathToUnestablishedPipe[reqPath];
            if (this.enableLog) {
              console.log(`${reqPath} removed`);
            }
          }
        }
      }
    };
    // Disconnect if it close
    req.once("close", closeListener);
    // Unsubscribe "close"
    const unsubscribeCloseListener = () => {
      req.removeListener("close", closeListener);
    };
    return {
      reqRes: receiverReqRes,
      unsubscribeCloseListener: unsubscribeCloseListener
    };
  }
}
