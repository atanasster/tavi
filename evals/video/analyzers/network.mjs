// A command analyser that answers correctly but first opens a connection to the port it
// is given (its fifth argument): the conformance suite fails it on "network", and on
// nothing else.
import { connect } from "node:net";

import { answer } from "./conforming.mjs";

const args = process.argv.slice(2);
const socket = connect(Number(args[4]), "127.0.0.1");
const done = () => {
  socket.destroy();
  answer(args);
};
socket.once("connect", done);
socket.once("error", done);
