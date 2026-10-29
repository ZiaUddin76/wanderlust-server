import express from 'express'
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import cors from "cors"
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = express()
const PORT = process.env.PORT || 8000;

// Without this, `req.body` is undefined for every JSON request, so
// POST /add-destination, POST /booking and PATCH /destinations/:id all fail.
app.use(express.json())

// Allow the deployed frontend plus any extra origin configured via env.
const allowedOrigins = [
  process.env.CLIENT_URL
].filter(Boolean)

app.use(cors({
  origin: allowedOrigins,
}))


const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  }
}


const mongoClient = await connectToMongoDB();
const db = mongoClient.db("wanderlust");
const destinationCollection = db.collection("destination")
const bookingCollection = db.collection("bookings")

// The JWKS must come from the better-auth app hosting /api/auth/jwks.
// The old hardcoded  breaks as soon as the
// backend runs anywhere else (deploy, CI, another machine).

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
)



const verifyToken = async (req, res, next) => {

  const authHeader = req.headers.authorization;
  // console.log(authHeader);

  if (!authHeader) {
    return res.status(401).send({ msg: 'Unauthorized' })
  }

  const token = authHeader.split(" ")[1]

  if (!token) {
    return res.status(401).send({ msg: 'Unauthorized' })
  }

  try {
    const { payload } = await jwtVerify(token, JWKS)
    // Handlers below use the verified claims (e.g. the user's email) so a
    // client can only ever act on its own session's data.
    req.auth = payload
    next();
  }
  catch (error) {
    console.error('JWT verification failed:', error);
    return res.status(401).send({ msg: 'Unauthorized — invalid or expired token.' });
  }

};





/** Runs an async route handler and turns thrown errors into JSON 500s. */
const wrap = (handler) => (req, res) => {
  handler(req, res).catch((err) => {
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).json({ message: "Something went wrong on the server." });
  });
};

/** Returns an ObjectId the request id can be parsed into, or null. */
function parseObjectId(id) {
  if (!id || typeof id !== "string" || !ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}


// ---------- Destinations ----------

app.post('/add-destination',
  verifyToken,
  wrap(async (req, res) => {
    const data = { ...req.body }
    // _id is immutable — never trust a client-supplied value.
    delete data._id

    if (!data.destinationName) {
      return res.status(400).json({ message: "destinationName is required." })
    }

    const result = await destinationCollection.insertOne(data)
    res.status(201).json({ result });
  }))


app.get('/destinations', wrap(async (req, res) => {
  const result = await destinationCollection.find().toArray()
  res.send(result)
}))



app.get('/featured-destination', wrap(async (req, res) => {
  // Sort by `_id` so the newest packages lead — without a sort the 5
  // "featured" ones would be whichever documents the cursor happens to see first.
  const result = await destinationCollection
    .find()
    .sort({ _id: -1 })
    .limit(5)
    .toArray()
  res.send(result)
}))




app.get('/destinations/:id',
  verifyToken,
  wrap(async (req, res) => {

    const { id } = req.params;
    const objectId = parseObjectId(id)

    if (!objectId) {
      return res.status(400).json({ message: "Invalid destination id." })
    }

    const result = await destinationCollection.findOne({ _id: objectId })

    if (!result) {
      return res.status(404).json({ message: "Destination not found." })
    }

    res.send(result)
  }))


app.patch('/destinations/:id',
  verifyToken,
  wrap(async (req, res) => {

  const { id } = req.params
  const objectId = parseObjectId(id)

  if (!objectId) {
    return res.status(400).json({ message: "Invalid destination id." })
  }

  const updatedData = { ...req.body }
  delete updatedData._id

  const result = await destinationCollection.updateOne(
    { _id: objectId },
    { $set: updatedData }
  )

  res.json(result)
}))


app.delete('/destination/:id',
  verifyToken,
  wrap(async (req, res) => {
  const { id } = req.params
  const objectId = parseObjectId(id)

  if (!objectId) {
    return res.status(400).json({ message: "Invalid destination id." })
  }

  const result = await destinationCollection.deleteOne({ _id: objectId })
  res.json(result)
}))


// ---------- Bookings ----------

app.post('/booking',
  verifyToken,
  wrap(async (req, res) => {
  const data = req.body

  // Only known fields, and never copy the destination's `_id` into
  // the bookings collection — every booking needs its own unique id.
  // Identity comes from the verified JWT, never from the request body —
  // a client cannot book with (or forge) somebody else's email.
  const bookingDoc = {
    destinationId: String(data.destinationId ?? data._id ?? ""),
    destinationName: String(data.destinationName ?? data.name ?? ""),
    imageUrl: String(data.imageUrl ?? ""),
    price: Number(data.price) || 0,
    departureDate: String(data.departureDate ?? ""),
    username: String(req.auth.name ?? ""),
    email: String(req.auth.email ?? "").trim(),
    userImage: String(req.auth.image ?? ""),
    status: "confirmed",
    bookingDate: new Date(),
  }

  if (!bookingDoc.email) {
    return res.status(401).json({
      message: "The verified token does not carry a usable email address.",
    })
  }

  if (!bookingDoc.destinationName || !bookingDoc.destinationId) {
    return res.status(400).json({
      message: "The selected travel package could not be found.",
    })
  }

  const result = await bookingCollection.insertOne(bookingDoc)
  res.status(201).json(result)
}))


app.get('/my-bookings/:email',
  verifyToken,
  wrap(async (req, res) => {
    const { email } = req.params

    // IDOR guard: the email in the path must belong to the token's owner,
    // otherwise anyone could enumerate another user's bookings.
    if (!req.auth.email || req.auth.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({
        message: "You can only view your own bookings.",
      })
    }

    // Express has already URL-decoded the path parameter once.
    const result = await bookingCollection
      .find({ email: req.auth.email })
      .toArray()

    res.send(result)
  }))


app.delete('/mybookings/:id',
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params
    const objectId = parseObjectId(id)

    if (!objectId) {
      return res.status(400).json({ message: "Invalid booking id." })
    }

    // `_id` values are ObjectIds — a plain string would never match.
    const booking = await bookingCollection.findOne({ _id: objectId })

    if (!booking) {
      return res.status(404).json({ message: "Booking not found." })
    }

    // Ownership guard: a valid token for another user must not cancel
    // someone else's booking.
    if (!req.auth.email || booking.email !== req.auth.email) {
      return res.status(403).json({
        message: "You can only cancel your own bookings.",
      })
    }

    const result = await bookingCollection.deleteOne({ _id: objectId })
    res.send(result)
  }))


app.get('/', (req, res) => {
  res.send({ message: 'Server is running fine!' })
})

// Unknown routes get JSON instead of an HTML 404 stack.
app.use((req, res) => {
  res.status(404).json({ message: `No route matches ${req.method} ${req.path}.` });
})


app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
})



export default app