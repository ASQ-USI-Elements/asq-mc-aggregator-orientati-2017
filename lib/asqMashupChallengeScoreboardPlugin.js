var ASQPlugin = require('asq-plugin');
var ObjectId = require('mongoose').Types.ObjectId;
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var mongoose = require('mongoose');
var ObjectId = mongoose.Types.ObjectId;
var assert = require('assert');
var _ = require('lodash');


//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-mashup-challenge-scoreboard',

  hooks:{
    "presenter_connected" : "presenterConnected",
    "viewer_connected" : "viewerConnected",
    "ghost_connected" : "ghostConnected",
    "after_answer_submission" : "afterAnswerSubmission"
  },

  presenterConnected: coroutine(function *presenterConnectedGen (info){
    if(! info.session_id) return info;

    var questionsWithScores = yield this.calculateScoreboard(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'scoreboard',
      questions: questionsWithScores
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  viewerConnected: coroutine(function *viewerConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithScores = yield this.calculateScoreboard(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'scoreboard',
      questions: questionsWithScores
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  ghostConnected: coroutine(function *ghostConnectedGen (info){
      return this.viewerConnected(info);
  }),

  afterAnswerSubmission: coroutine(function *answerSubmissionGen (info){
    // make sure answer question exists
    var answer = info.answer;
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec();
    assert(question,
      'Could not find question with id ' + questionUid + ' in the database');

    //make sure it's an answer for an asq-rating-q question
    if(question.type !== 'asq-rating-q') {
      return answer;
    }

    var questionsWithScores = yield this.calculateScoreboard(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'scoreboard',
      questions: questionsWithScores
    }

    this.asq.socket.emitToRoles('asq:question_type', event, answer.session.toString(), 'ctrl', 'folo', 'ghost')

    //this will be the argument to the next hook
    return info;
  }),

  calculateScoreboard: coroutine(function *calculateScoreboardGen(session_id, presentation_id){

    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, 'asq-rating-q');
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          session: session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $unwind: "$submission" },
      { $group:{
          "_id":{
            "question" : "$_id.question",
            "rating_id": "$submission._id"
          },
          "numVotes" : { $sum: 1 },
          "rating":{$avg: "$submission.rating"},
          "submitDate":{$first: "$submitDate"},
          "submission": {$first: "$submission"},
        }
      },
      { $group:{
          "_id": {
            "question" : "$_id.question",
          },
          "numVotes" : { $first: "$numVotes" },
          "ratingItems":{$push: {"_id" : "$_id.rating_id" , "rating": "$rating"}},
          "total" : {$avg: "$rating"}
        }
      },
      { $project : {
          "_id": 0,
          "question" : "$_id.question",
          "ratingItems" : 1,
          "total" : 1,
          "numVotes" : 1
        }
      },
      { $sort:{"total": -1}},
    ]
    var ratings = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    // console.log(ratings)

    ratings.forEach(function(rating, index){
      rating.rank = index+1;
    });


    questions.forEach(function(q){
      q.data.rank = '-';
      q.data.numVotes = 0;
      for(var i=0, l=ratings.length; i<l; i++){
        if(ratings[i].question.toString() == q._id){
          this.copyRatings(ratings[i], q);
          q.data.numVotes = ratings[i].numVotes;
          q.data.total = ratings[i].total;
          q.data.rank = ratings[i].rank;
          break;
        }
      }
    }.bind(this));

    return questions;
  }),

  copyRatings : function(aggrRating, question){
    for(var i = 0, l = aggrRating.ratingItems.length; i<l; i++){
      for(var j = 0, l2 = question.data.ratingItems.length; j<l2; j++){
        if(aggrRating.ratingItems[i]._id.toString()  == question.data.ratingItems[j]._id){
          question.data.ratingItems[j].rating = aggrRating.ratingItems[i].rating;
          break;
        }
      }
    }
  }
});
