const sendSuccessResponse = (res, data, message = 'Success', statusCode = 200) => {
    return res.status(statusCode).json({
        success: true,
        data,
        message
    });
};

const sendErrorResponse = (res, message = 'Error', statusCode = 500, data = null) => {
    return res.status(statusCode).json({
        success: false,
        data,
        message
    });
};

module.exports = {
    sendSuccessResponse,
    sendErrorResponse
};
