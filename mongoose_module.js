////  =========- Read Configure File & LOG properties -========================///
configurationFile = './config/main_config.json';
var fs = require('fs-extra');
var conf = JSON.parse(fs.readFileSync(configurationFile));
var logmodule = "MONGOOSE"
var log4js = require('log4js');
log4js.configure({ "appenders": [conf.log4js_conf.ALL,conf.log4js_conf[logmodule]]});
var logger = log4js.getLogger(logmodule);
logger.setLevel(conf.loglevel[logmodule]);
////==========================================================================///

var mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/loyalty');
var db = mongoose.connection;
var Schema = mongoose.Schema,
    ObjectId = Schema.ObjectId;

var tokenSchema = new Schema({
   token: { token_no: String,
   	        updatedate: String
   }
},{collection : "subscriber"})
	
var newtokenSchema = new Schema({  
   _id: Schema.Types.ObjectId,
   doctype: String,
   subscriberid: {type: String, ref: "subscriber"},
   accountid: String,
   token: {
              app: {
                 token_no: String,
                 updatedate: String,
                 ip: String,
                 deviceid: String ,
                 online: [ { queue : String , updatedate : String,_id: false } ] 
              },
               web: {
                 token_no: String,
                 updatedate: String,
                 ip: String,
                 deviceid: String ,
                 online: [ { queue : String , updatedate : String,_id: false } ] 
              } 
  }
   
},{collection : "authentication", versionKey: false})	

var SubsSchema = new Schema({
   _id : Schema.Types.ObjectId,
   doctype: String,
   imgfile: String,
   accountid: String,
   password: String,
   like: [{status:{type: Number},
   	      stockitemid: {type: String, ref: "stock"},
   	      createdate: String,
   	      _id: false 
   	    }],
   sharewishlist: [{type: String, ref: "subscriber"}],
   wishlist:[{stockitemid: {type: String, ref: "stock"},
   	         createdate: String,
   	         _id: false
   	       }],
   wishlistpreference: {
     notifypointenough: { type: String, default: ""},
     notifypromotion: { type: String, default: ""} 
   },
   interest: {
      adventure: String,
      automotive: String,
      architecture: String,
      beauty: String,
      dining: String,
      gadget: String,
      games: String,
      health: String,
      home_decor: String,
      lifestyle: String,
      movie: String,
      photography: String,
      romantic: String,
      sports: String,
      technology: String,
      travel: String
             },
   displayname : String,
   displaystatus : String,
   token: { token_no: String,
   	        updatedate: String
   	      },
   online_queue : { queue: String,
   	                updatedate: String
   	              }

},{collection : "subscriber"})

var ChatSchema = new Schema({
   doctype: String ,
   to : { type: String , ref : "subscriber"},
   from : [{ 
   	         stockitemid : {type: String, ref : "stock"}
   	      }]
},{collection : "chat"})
	
var StockSchema = new Schema({
	 _id: Schema.Types.ObjectId,
   doctype: String,
   itemid: { type: String , ref : "business"},
   merchantid : { type: String , ref : "business"} 
},{collection : "stock"})
	
var BussSchema = new Schema({
	 _id: Schema.Types.ObjectId,
   doctype: String,
   rewarditemid : String,
   itemid : { type: String , ref : "business"},
   merchantid : { type: String , ref : "business"}
},{collection : "business"})

var gblSchema = new Schema({
    _id: Schema.Types.ObjectId,
    doctype: String,
    code: String,
    name: String,
    value: String,
    description: String,
    type: String,
    site: String,
    createdate: Date,
    updatedate: Date 
},{collection : "business"})

var earnSchema = new Schema({
   _id: Schema.Types.ObjectId,
   doctype: String,
   ruleid: String,
   priority: Number,
   description:String,
   status: String,
   validfromdate: String,
   validtodate: String,
   createdate: String,
   updatedate: String,
   serviceid: String,
   condition: [
        {
          _id: String,
          conditionid: {type: String, ref: "earn"}
        }
   ],
   reward: [
     {
       _id: Schema.Types.ObjectId,
       reward: [
         {
           _id: Schema.Types.ObjectId,
           amount: Number,
           ratio: Number,
           rewarditemid: String,
           rewardinstanceid: String 
        } 
      ],
       remark: String,
       subscriberclassid: String 
    } 
  ],
  promotion: [
        {
          _id: String,
          reward: [
            {
              _id: String,
              amount: Number,
              ratio: Number,
              rewarditemid: String,
              rewardinstanceid: String
            }
          ],
          remark: String,
          status: String,
          startdate: String,
          enddate: String,
          subscriberclassid: String
        }
      ]
},{collection : "business"})
	
var friendSchema = new Schema({
   doctype: { type: String , defalut : "docfriend"} ,
   subscriberid : { type: String , ref : "subscriber"},
   friends : [{
        subscriberid: { type: String , ref : "subscriber"},
        status: { type: String , defalut : "A"},
        createdate: String,
   }]
},{collection : "chat"})

var giftpickupSchema = new Schema({
   _id: Schema.Types.ObjectId,
   doctype: String,
   to: String,
   from: [
     {
       _id: Schema.Types.ObjectId,
       name: String,
       itemid : { type: String, ref: "business"},
       from: String,
       fromsubscriberid : { type: String , ref : "subscriber"},
       transactionno: String,
       voucherno: String,
       message: String,
       gifttype: Number,
       quantity: Number,
       expire: { type: Number, default: 30},
       status: { type: Number, default: 2},   // 1=gift, 2=pickup, 3=delete
       createdate: String,
       stockitemid: String,
       mobile_gift: { type: Number, default: 0} //0=delete,1=gift
    }]   
},{collection : "chat"})

var groupSchema = new Schema({
	 _id : Schema.Types.ObjectId,
   doctype: String ,
   groupname: String,
   mastername: String,
   imgfile: String,
   status: String,
   createdate: String,
   updatedate: String,
   member : [{
        subscriberid: { type: String , ref : "subscriber"},
        status: String,
        createdate: String,
        topping : Number,
        threshold : Number,
        _id : false
   }]
},{collection : "subscribergroup", versionKey: false})

var transSchema = new Schema({
   _id: Schema.Types.ObjectId,
   doctype: String,
   subscriberid: { type: String, ref: "subscriber"},
   subscribergroupid: { type: String, ref: "group"}
},{collection : "transaction"})

var token = mongoose.model('token',tokenSchema)
var Subsc = mongoose.model('subscriber', SubsSchema);
var Chat = mongoose.model('chat', ChatSchema);
var Stock = mongoose.model('stock', StockSchema);
var Buss = mongoose.model('business', BussSchema);
var friend = mongoose.model('friend', friendSchema);
var group = mongoose.model('group', groupSchema);
var globalconfig = mongoose.model('globalconfig', gblSchema);
var giftpickup = mongoose.model('giftpickup', giftpickupSchema);
var earn = mongoose.model('earn', earnSchema);
var transaction = mongoose.model('transaction', transSchema);

var newtoken = mongoose.model('newtoken',newtokenSchema)

module.exports.token = token
module.exports.Subsc = Subsc
module.exports.Chat = Chat
module.exports.Stock = Stock
module.exports.Buss = Buss
module.exports.db = db
module.exports.friend = friend
module.exports.group = group
module.exports.globalconfig = globalconfig
module.exports.giftpickup = giftpickup
module.exports.earn = earn
module.exports.transaction = transaction
module.exports.newtoken = newtoken



/*
Chat
.findOne({"to":"55e5518565f299b80fbf834b"})
.populate('to')
.populate('from.stockitemid', 'itemid')
.exec(function (err, chat) {
  if (err) return handleError(err);
  //console.log(JSON.stringify(chat));
  // prints "The creator is Aaron"
  db.close()
});
*/

