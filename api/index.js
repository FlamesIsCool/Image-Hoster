const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const bcrypt = require('bcrypt');
const methodOverride = require('method-override');

// Initialize Express
const app = express();

// Connect to MongoDB
// For production, consider using MongoDB Atlas; for local testing, you can use a local MongoDB instance.
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/image_hoster', { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
})
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));

// Set view engine to EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));
app.use(flash());

// Expose flash messages and current user to templates
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.currentUser = req.session.user || null;
  next();
});

// -------------------
// Mongoose Models
// -------------------

// models/User.js
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String
});
const User = mongoose.model('User', userSchema);

// models/Image.js
const imageSchema = new mongoose.Schema({
  filename: String,
  thumbnail: String,
  customSlug: { type: String, unique: true, sparse: true },
  uploadDate: { type: Date, default: Date.now },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});
const Image = mongoose.model('Image', imageSchema);

// -------------------
// Multer Configuration for File Uploads
// -------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'public', 'uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if(ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg' && ext !== '.gif') {
      return cb(new Error('Only images are allowed'));
    }
    cb(null, true);
  }
});

// -------------------
// Authentication Middleware
// -------------------
function isLoggedIn(req, res, next) {
  if (req.session.user) return next();
  req.flash('error', 'You must be logged in.');
  res.redirect('/login');
}

// -------------------
// Routes
// -------------------

// Home: Image gallery
app.get('/', async (req, res) => {
  try {
    const images = await Image.find({}).sort({ uploadDate: -1 }).populate('user');
    res.render('index', { images });
  } catch (err) {
    req.flash('error', 'Error fetching images.');
    res.redirect('/');
  }
});

// Registration
app.get('/register', (req, res) => {
  res.render('register');
});
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    const user = new User({ username, password: hash });
    await user.save();
    req.flash('success', 'Registered successfully, please login.');
    res.redirect('/login');
  } catch (err) {
    req.flash('error', 'Error registering user. Username may already exist.');
    res.redirect('/register');
  }
});

// Login
app.get('/login', (req, res) => {
  res.render('login');
});
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if(user) {
      const valid = await bcrypt.compare(password, user.password);
      if(valid) {
        req.session.user = user;
        req.flash('success', 'Logged in successfully.');
        return res.redirect('/');
      }
    }
    req.flash('error', 'Invalid credentials.');
    res.redirect('/login');
  } catch (err) {
    req.flash('error', 'Error logging in.');
    res.redirect('/login');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Upload (requires login)
app.get('/upload', isLoggedIn, (req, res) => {
  res.render('upload');
});
app.post('/upload', isLoggedIn, upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    if(!file) {
      req.flash('error', 'No file selected.');
      return res.redirect('/upload');
    }
    // Create a thumbnail with Sharp
    const thumbFilename = 'thumb-' + file.filename;
    await sharp(file.path)
      .resize(128, 128)
      .toFile(path.join(file.destination, thumbFilename));
    
    // Handle optional custom slug
    let customSlug = req.body.customSlug;
    if(customSlug) {
      const existing = await Image.findOne({ customSlug });
      if(existing) {
        req.flash('error', 'Custom slug already in use.');
        return res.redirect('/upload');
      }
    } else {
      customSlug = undefined;
    }
    
    const newImage = new Image({
      filename: file.filename,
      thumbnail: thumbFilename,
      customSlug,
      user: req.session.user._id
    });
    await newImage.save();
    req.flash('success', 'Image uploaded successfully.');
    res.redirect(`/image/${newImage._id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Error uploading image.');
    res.redirect('/upload');
  }
});

// Image detail
app.get('/image/:id', async (req, res) => {
  try {
    const image = await Image.findById(req.params.id).populate('user');
    if(!image) {
      req.flash('error', 'Image not found.');
      return res.redirect('/');
    }
    res.render('image_detail', { image });
  } catch (err) {
    req.flash('error', 'Error fetching image details.');
    res.redirect('/');
  }
});

// Direct image route via custom slug (for sharing)
app.get('/i/:customSlug', async (req, res) => {
  try {
    const image = await Image.findOne({ customSlug: req.params.customSlug });
    if(!image) return res.status(404).send('Image not found');
    res.sendFile(path.join(__dirname, '..', 'public', 'uploads', image.filename));
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// Export the Express app as a serverless function
module.exports = app;
