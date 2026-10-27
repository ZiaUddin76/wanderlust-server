import express from 'express'
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import cors from "cors"

const app = express()
const PORT = process.env.PORT || 8000;

// Without this, `req.body` is undefined for every JSON request, so
// POST /add-destination, POST /booking and PATCH /destinations/:id all fail.
app.use(express.json())

// Allow the deployed frontend plus any extra origin configured via env.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://wanderlust-mocha-two.vercel.app',
  'http://localhost:3000',
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

app.post('/add-destination', wrap(async (req, res) => {
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


app.get('/destinations/:id', wrap(async (req, res) => {
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


app.patch('/destinations/:id', wrap(async (req, res) => {
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


app.delete('/destination/:id', wrap(async (req, res) => {
  const { id } = req.params
  const objectId = parseObjectId(id)

  if (!objectId) {
    return res.status(400).json({ message: "Invalid destination id." })
  }

  const result = await destinationCollection.deleteOne({ _id: objectId })
  res.json(result)
}))


// ---------- Bookings ----------

app.post('/booking', wrap(async (req, res) => {
  const data = req.body

  // Store only known fields, and never copy the destination's `_id` into
  // the bookings collection — every booking needs its own unique id.
  const bookingDoc = {
    destinationId: String(data.destinationId ?? data._id ?? ""),
    destinationName: String(data.destinationName ?? data.name ?? ""),
    imageUrl: String(data.imageUrl ?? ""),
    price: Number(data.price) || 0,
    departureDate: String(data.departureDate ?? ""),
    username: String(data.username ?? ""),
    email: String(data.email ?? "").trim(),
    userImage: String(data.image ?? ""),
    status: "confirmed",
    bookingDate: new Date(),
  }

  if (!bookingDoc.email) {
    return res.status(400).json({
      message: "You must be logged in to make a booking.",
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


app.get('/my-bookings/:email', wrap(async (req, res) => {
  const { email } = req.params

  // Express has already URL-decoded the path parameter once.
  const result = await bookingCollection
    .find({ email })
    .toArray()

  res.send(result)
}))


app.delete('/mybookings/:id', wrap(async (req, res) => {
  const { id } = req.params
  const objectId = parseObjectId(id)

  if (!objectId) {
    return res.status(400).json({ message: "Invalid booking id." })
  }

  // `_id` values are ObjectIds — a plain string would never match.
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
