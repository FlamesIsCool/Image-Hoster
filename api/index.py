import os
from datetime import datetime
from flask import Flask, render_template, redirect, url_for, request, flash, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, login_user, logout_user, login_required, current_user, UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from PIL import Image

# Check if we're on Vercel
if os.environ.get("VERCEL"):
    # Use /tmp for writable operations in serverless functions
    static_folder = os.path.join(os.getcwd(), "static")
    template_folder = os.path.join(os.getcwd(), "templates")
    db_path = '/tmp/app.db'
    upload_folder = '/tmp/uploads'
else:
    # Use local paths when running locally
    static_folder = os.path.join(os.path.dirname(__file__), "..", "static")
    template_folder = os.path.join(os.path.dirname(__file__), "..", "templates")
    db_path = os.path.join(os.path.dirname(__file__), "..", "app.db")
    upload_folder = os.path.join(os.path.dirname(__file__), "..", "static", "uploads")

app = Flask(__name__, static_folder=static_folder, template_folder=template_folder)
app.config['SECRET_KEY'] = 'your-secret-key'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + db_path
app.config['UPLOAD_FOLDER'] = upload_folder
app.config['ALLOWED_EXTENSIONS'] = {'png', 'jpg', 'jpeg', 'gif'}

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Models
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password_hash = db.Column(db.String(150), nullable=False)
    images = db.relationship('ImageModel', backref='uploader', lazy=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
        
    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class ImageModel(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    filename = db.Column(db.String(300), nullable=False)
    thumbnail = db.Column(db.String(300), nullable=True)
    custom_slug = db.Column(db.String(100), unique=True, nullable=True)
    upload_date = db.Column(db.DateTime, default=datetime.utcnow)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS']

def create_thumbnail(image_path, thumbnail_path, size=(128, 128)):
    try:
        img = Image.open(image_path)
        img.thumbnail(size)
        img.save(thumbnail_path)
    except Exception as e:
        print("Error creating thumbnail:", e)

# Ensure database and uploads folder exist
@app.before_first_request
def initialize():
    if not os.path.exists(app.config['UPLOAD_FOLDER']):
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    db.create_all()

# Routes
@app.route('/')
def index():
    images = ImageModel.query.order_by(ImageModel.upload_date.desc()).all()
    return render_template('index.html', images=images)

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        if User.query.filter_by(username=username).first():
            flash('Username already exists!')
            return redirect(url_for('register'))
        new_user = User(username=username)
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()
        flash('Registration successful! Please login.')
        return redirect(url_for('login'))
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user)
            return redirect(url_for('index'))
        else:
            flash('Invalid username or password')
            return redirect(url_for('login'))
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))

@app.route('/upload', methods=['GET', 'POST'])
@login_required
def upload():
    if request.method == 'POST':
        if 'image' not in request.files:
            flash('No file part')
            return redirect(request.url)
        file = request.files['image']
        if file.filename == '':
            flash('No selected file')
            return redirect(request.url)
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(file_path)

            thumbnail_filename = "thumb_" + filename
            thumbnail_path = os.path.join(app.config['UPLOAD_FOLDER'], thumbnail_filename)
            create_thumbnail(file_path, thumbnail_path)

            custom_slug = request.form.get('custom_slug')
            if custom_slug:
                if ImageModel.query.filter_by(custom_slug=custom_slug).first():
                    flash('Custom link already in use. Please choose another.')
                    return redirect(url_for('upload'))

            new_image = ImageModel(
                filename=filename,
                thumbnail=thumbnail_filename,
                uploader=current_user,
                custom_slug=custom_slug
            )
            db.session.add(new_image)
            db.session.commit()
            flash('Image uploaded successfully!')
            return redirect(url_for('image_detail', image_id=new_image.id))
    return render_template('upload.html')

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/image/<int:image_id>')
def image_detail(image_id):
    image = ImageModel.query.get_or_404(image_id)
    return render_template('image_detail.html', image=image)

@app.route('/i/<custom_slug>')
def image_by_slug(custom_slug):
    image = ImageModel.query.filter_by(custom_slug=custom_slug).first_or_404()
    return send_from_directory(app.config['UPLOAD_FOLDER'], image.filename)

# Expose the WSGI app for Vercel
app = app
